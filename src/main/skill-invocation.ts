import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getConfigValue } from './config';
import { assignSpaceFolder, createSpace, getSkill, updateCanvasContent } from './database';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import { createSpaceFolder, scheduleAutoCommit } from './workspace';
import { withCanvasContract } from './canvas/canvas-contract';
import { WHIM_REPORT_CANVAS_ID } from './canvas/sdk-canvas-provider';
import type {
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

export async function invokeSkill(input: SkillInvocationInput): Promise<SkillInvocationResult | { error: string }> {
  const workspace = getConfigValue('workspace');
  if (!workspace) return { error: 'no_workspace' };

  const skill = getSkill(input.skillId);
  if (!skill) return { error: 'not_found' };

  const intent = normalizeIntent(input.intent);
  const createdAt = new Date().toISOString();
  let skillPreferredAgent: string | undefined;
  let canvasSettings: ReturnType<typeof readSkillCanvasSettings> = {};
  try {
    const skillContent = fs.readFileSync(skill.filePath, 'utf-8');
    const { frontmatter } = parseFrontmatter<SkillFrontmatter>(skillContent);
    if (typeof frontmatter.preferred_agent === 'string' && frontmatter.preferred_agent.trim()) {
      skillPreferredAgent = frontmatter.preferred_agent.trim();
    }
    canvasSettings = readSkillCanvasSettings(frontmatter);
  } catch {
    // Skill metadata is already indexed; missing optional preferred_agent should not block invocation.
  }

  const preferredAgent = input.preferredAgent?.trim() || skillPreferredAgent;
  const canvasArtifacts = canvasSettings.canvasArtifacts;
  const wantsCanvas = typeof canvasArtifacts === 'string';
  // Registering a canvas does not make a model use it, so a canvas run carries
  // an explicit obligation to publish one.
  const instructions = wantsCanvas
    ? withCanvasContract(buildInvocationInstructions(skill.name, intent))
    : buildInvocationInstructions(skill.name, intent);
  const source = input.source ?? 'api';
  // Distinguishes this occurrence from earlier ones, so completion can tell a
  // freshly published report from one left by a previous run.
  const runId = crypto.randomUUID();
  const titleSeed = intent ? `${skill.name}: ${intent}` : skill.name;
  const space = createSpace({ body: titleSeed }, skill.id);
  const folder = createSpaceFolder(workspace, space.id, skill.name);
  assignSpaceFolder(space.id, folder);
  space.folder = folder;

  const frontmatter: SkillInvocationFrontmatter = {
    skills: [skill.id],
    instructions,
    ...(preferredAgent ? { preferred_agent: preferredAgent } : {}),
    ...(canvasArtifacts !== undefined ? { canvas_artifacts: canvasArtifacts } : {}),
    ...(canvasSettings.spaceMode ? { space_mode: canvasSettings.spaceMode } : {}),
    skill_invocation: {
      skill_id: skill.id,
      source,
      ...(intent ? { source_prompt: intent } : {}),
      created_at: createdAt,
      run_id: runId,
    },
  };

  const canvasContent = serializeFrontmatter(frontmatter, buildCanvasBody(titleSeed));
  const canvasPath = path.join(workspace, folder, 'canvas.md');
  fs.writeFileSync(canvasPath, canvasContent, 'utf-8');
  updateCanvasContent(space.id, canvasContent);
  scheduleAutoCommit(workspace);

  if (!input.run) {
    return { space, canvasContent };
  }

  const { launchDocumentAgent } = await import('./agent-service');
  const agentResult = await launchDocumentAgent(space.id, workspace, folder, {
    ...(preferredAgent ? { personaHandle: preferredAgent } : {}),
    promptOverride: instructions,
  });
  if ('error' in agentResult) {
    return { space, canvasContent, error: agentResult.error };
  }

  return { space, canvasContent, agent: agentResult };
}
