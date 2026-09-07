import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigValue } from './config';
import { assignSpaceFolder, createSpace, getSkill, getSpace, updateCanvasContent } from './storage';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { createSpaceFolder, resolveSpaceFolder, scheduleAutoCommit } from './workspace';
import { getSkillSchedule } from './storage';
import { buildScheduledInstructions } from './services/scheduled-instructions';
import { notifyAllWindows } from './notify';
import type { ScheduledInvocation } from '../shared/skill-schedule';
import { ARTIFACT_FILE, ARTIFACT_DATA_FILE, CANVASES_DIR } from './canvas/artifact-store';
import { listArtifacts } from './storage';
import { buildRefreshFraming, resolveSpaceForSkill } from './services/skill-space-reuse';
import { withCanvasContract } from './canvas/canvas-contract';
import { WHIM_REPORT_CANVAS_ID } from './canvas/sdk-canvas-provider';
import { resolveSkillCanvasDefinition } from './canvas/skill-canvas-template';
import type {
  Space,
  SkillFrontmatter,
  SkillInvocationFrontmatter,
  SkillInvocationInput,
  SkillInvocationResult,
} from '../shared/types';

function normalizeIntent(intent?: string): string {
  return (intent || '').trim();
}

function buildInvocationInstructions(skillName: string, intent: string): string {
  if (intent) {
    return `Run the ${skillName} skill for this request:\n\n${intent}`;
  }
  return `Run the ${skillName} skill using its default instructions.`;
}

/** Prior artifacts in a reused space, described by path for the prompt. */
async function describePriorArtifacts(workspaceRoot: string, folder: string) {
  try {
    return (await listArtifacts(workspaceRoot, folder))
      .filter(a => a.published)
      .map(a => ({
        artifactId: a.artifactId,
        title: a.title,
        relativeHtmlPath: path.posix.join(CANVASES_DIR.split(path.sep).join('/'), a.artifactId, ARTIFACT_FILE),
        ...(a.hasData
          ? {
            relativeDataPath: path.posix.join(
              CANVASES_DIR.split(path.sep).join('/'), a.artifactId, ARTIFACT_DATA_FILE,
            ),
          }
          : {}),
      }));
  } catch {
    return [];
  }
}

function buildCanvasBody(title: string): string {
  return `# ${title}\n`;
}

/**
 * Read a skill's canvas settings.
 *
 * `canvas` accepts a boolean or a canvas id; `space_mode` chooses between
 * refreshing the skill's existing space and starting a new one each run.
 */
function readSkillCanvasSettings(frontmatter: SkillFrontmatter): {
  canvasArtifacts?: string | false;
  spaceMode?: 'new' | 'reuse';
} {
  const raw = frontmatter.canvas;
  let canvasArtifacts: string | false | undefined;
  if (raw === true || raw === 'true') canvasArtifacts = WHIM_REPORT_CANVAS_ID;
  else if (raw === false || raw === 'false') canvasArtifacts = false;
  else if (typeof raw === 'string' && raw.trim()) canvasArtifacts = raw.trim();

  const modeRaw = frontmatter.space_mode;
  const spaceMode = modeRaw === 'new' || modeRaw === 'reuse' ? modeRaw : undefined;

  return {
    ...(canvasArtifacts !== undefined ? { canvasArtifacts } : {}),
    ...(spaceMode ? { spaceMode } : {}),
  };
}

type InvocationInput = SkillInvocationInput & { scheduledRun?: ScheduledInvocation };

export async function invokeSkill(input: InvocationInput): Promise<SkillInvocationResult | { error: string }> {
  // Serialize per skill. Reuse asks "is a run already using this space?" and
  // then writes canvas.md and launches — but the launch is what makes the run
  // visible to that question. Two overlapping occurrences of the same skill (a
  // schedule firing while the user runs it by hand) would both see an idle
  // space, both claim it, and the second would overwrite the first's
  // instructions before it had even started.
  return withSkillLock(input.skillId, async () => (await invokeSkillSerialized(input)));
}

/**
 * One in-flight invocation per skill id.
 *
 * The tail deliberately swallows rejections so a failed invocation cannot
 * poison later ones, and entries are dropped once nothing is queued behind
 * them so the map does not grow for the life of the process.
 */
const skillLocks = new Map<string, Promise<unknown>>();

async function withSkillLock<T>(skillId: string, fn: () => Promise<T>): Promise<T> {
  const prev = skillLocks.get(skillId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(() => undefined, () => undefined);
  skillLocks.set(skillId, tail);
  void tail.then(() => {
    if (skillLocks.get(skillId) === tail) skillLocks.delete(skillId);
  });
  return next;
}

async function invokeSkillSerialized(input: InvocationInput): Promise<SkillInvocationResult | { error: string }> {
  const workspace = getConfigValue('workspace');
  if (!workspace) return { error: 'no_workspace' };

  const skill = (await getSkill(input.skillId));
  if (!skill) return { error: 'not_found' };

  const savedSchedule = input.run && !input.scheduledRun && input.source !== 'schedule'
    ? (await getSkillSchedule(workspace, skill.id))
    : null;
  const scheduledRun: ScheduledInvocation | undefined = input.scheduledRun ?? (savedSchedule?.enabled && savedSchedule.output === 'canvas'
    ? {
      scheduleId: savedSchedule.id,
      runId: crypto.randomUUID(),
      scheduledAt: new Date().toISOString(),
      timeZone: savedSchedule.timeZone,
      readOnlyServers: savedSchedule.readOnlyServers,
      previousSpaceId: savedSchedule.lastSuccessfulRun?.spaceId,
      lastSuccessfulAt: savedSchedule.lastSuccessfulRun?.completedAt,
      manual: true,
    }
    : undefined);
  const resultFirst = !!scheduledRun && scheduledRun.output !== 'legacy';
  const intent = normalizeIntent(input.intent || (resultFirst ? savedSchedule?.intent : undefined));
  const createdAt = new Date().toISOString();
  let skillPreferredAgent: string | undefined;
  let canvasSettings: ReturnType<typeof readSkillCanvasSettings> = {};
  let skillContent: string;
  try {
    skillContent = fs.readFileSync(skill.filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter<SkillFrontmatter>(skillContent);
    if (typeof frontmatter.preferred_agent === 'string' && frontmatter.preferred_agent.trim()) {
      skillPreferredAgent = frontmatter.preferred_agent.trim();
    }
    canvasSettings = readSkillCanvasSettings(frontmatter);
  } catch (error) {
    console.error(`[skill] Could not read ${skill.id}:`, error);
    return { error: 'Could not read the skill instructions. Restore the skill file before running it.' };
  }

  const preferredAgent = input.preferredAgent?.trim() || skillPreferredAgent;
  const canvasArtifacts = resultFirst ? false : canvasSettings.canvasArtifacts;
  const wantsCanvas = typeof canvasArtifacts === 'string';
  const source = input.source ?? 'api';
  // Distinguishes this occurrence from earlier ones, so completion can tell a
  // freshly published report from one left by a previous run.
  const runId = scheduledRun?.runId ?? crypto.randomUUID();
  const titleSeed = resultFirst
    ? `${skill.name} - ${new Date(scheduledRun.scheduledAt).toLocaleDateString('en-US', {
      timeZone: scheduledRun.timeZone, year: 'numeric', month: 'short', day: 'numeric',
    })}`
    : intent ? `${skill.name}: ${intent}` : skill.name;

  // Only skills that produce artifacts reuse their space by default. A skill
  // that runs daily would otherwise leave a space per occurrence, and a hundred
  // near-identical spaces is worse than no report: the user stops reading them.
  const wantsReuse = !resultFirst && (canvasSettings.spaceMode === 'reuse'
    || (wantsCanvas && canvasSettings.spaceMode !== 'new'));
  const resolution = wantsReuse
    ? await resolveSpaceForSkill({
      skillId: skill.id,
      workspaceRoot: workspace,
      ...(canvasSettings.spaceMode ? { spaceMode: canvasSettings.spaceMode } : {}),
    })
    : null;

  let space: Space;
  let folder: string;
  if (resolution?.space?.folder) {
    space = resolution.space;
    folder = resolution.space.folder;
  } else {
    space = (await createSpace({ body: titleSeed }, skill.id));
    folder = createSpaceFolder(workspace, space.id, skill.name);
    (await assignSpaceFolder(space.id, folder));
    space.folder = folder;
  }

  const reusedSpace = !!resolution?.space?.folder;
  // Registering a canvas does not make a model use it, so a canvas run carries
  // an explicit obligation to publish one.
  // The contract has to name the canvas the agent will actually see, which is
  // namespaced when the skill ships its own template.
  const skillCanvas = wantsCanvas && canvasArtifacts !== WHIM_REPORT_CANVAS_ID
    ? resolveSkillCanvasDefinition(workspace, skill.id, canvasArtifacts as string)
    : null;
  let instructions = wantsCanvas
    ? withCanvasContract(
      buildInvocationInstructions(skill.name, intent),
      skillCanvas?.canvasId ?? WHIM_REPORT_CANVAS_ID,
    )
    : buildInvocationInstructions(skill.name, intent);
  if (reusedSpace) {
    // Without this the agent treats the space as blank and rewrites the report
    // from scratch, losing what the user had already read and acted on.
    instructions += buildRefreshFraming((await describePriorArtifacts(workspace, folder)));
  }
  if (resultFirst) {
    const previousSpace = scheduledRun.previousSpaceId ? (await getSpace(scheduledRun.previousSpaceId)) : null;
    const previousCanvas = previousSpace?.folder
      ? path.join(resolveSpaceFolder(workspace, previousSpace.folder), 'canvas.md')
      : undefined;
    instructions = buildScheduledInstructions(skill.name, intent, scheduledRun, previousCanvas);
    fs.writeFileSync(path.join(workspace, folder, 'skill-instructions.md'), skillContent, 'utf-8');
  }

  const frontmatter: SkillInvocationFrontmatter = {
    skills: [skill.id],
    instructions,
    ...(preferredAgent ? { preferred_agent: preferredAgent } : {}),
    ...(canvasArtifacts !== undefined ? { canvas_artifacts: canvasArtifacts } : {}),
    ...(resultFirst ? { space_mode: 'new' } : canvasSettings.spaceMode ? { space_mode: canvasSettings.spaceMode } : {}),
    skill_invocation: {
      skill_id: skill.id,
      source,
      ...(intent ? { source_prompt: intent } : {}),
      created_at: createdAt,
      run_id: runId,
      ...(scheduledRun ? {
        schedule_id: scheduledRun.scheduleId,
        scheduled_at: scheduledRun.scheduledAt,
        manual: scheduledRun.manual === true,
        ...(resultFirst ? {
          instruction_snapshot: 'skill-instructions.md',
          instruction_sha256: crypto.createHash('sha256').update(skillContent).digest('hex'),
        } : {}),
      } : {}),
    },
  };

  const canvasPath = path.join(workspace, folder, 'canvas.md');
  const existing = reusedSpace && fs.existsSync(canvasPath)
    ? parseFrontmatter<Record<string, unknown>>(fs.readFileSync(canvasPath, 'utf-8'))
    : null;
  const body = existing?.body ?? (resultFirst
    ? `${buildCanvasBody(titleSeed)}\nPreparing your result. The skill is linked above; findings will appear here.\n`
    : buildCanvasBody(titleSeed));
  const canvasContent = serializeFrontmatter({ ...existing?.frontmatter, ...frontmatter }, body);
  fs.writeFileSync(canvasPath, canvasContent, 'utf-8');
  (await updateCanvasContent(space.id, canvasContent));
  scheduleAutoCommit(workspace);

  if (!input.run) {
    return { space, canvasContent };
  }

  const { launchDocumentAgent } = await import('./agent-service');
  const agentResult = await launchDocumentAgent(space.id, workspace, folder, {
    ...(preferredAgent ? { personaHandle: preferredAgent } : {}),
    promptOverride: instructions,
    ...(scheduledRun ? { scheduledRun } : {}),
  });
  if ('error' in agentResult) {
    if (resultFirst) {
      const current = fs.readFileSync(canvasPath, 'utf-8');
      const failedContent = `${current.trimEnd()}\n\n## Run could not start\n\n${agentResult.error}\n`;
      fs.writeFileSync(canvasPath, failedContent, 'utf-8');
      (await updateCanvasContent(space.id, failedContent));
      notifyAllWindows('canvas:content-updated', { spaceId: space.id, content: failedContent });
      scheduleAutoCommit(workspace);
      return { space, canvasContent: failedContent, error: agentResult.error };
    }
    return { space, canvasContent, error: agentResult.error };
  }

  return { space, canvasContent, agent: agentResult };
}
