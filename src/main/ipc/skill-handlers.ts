import { registerIpcHandler } from './registry';
import { shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { isInitialized, listSkills, getSkill, upsertSkill, removeSkill, updateSkillSchedule } from '../storage';
import { readDocument, writeDocument, createSkillDocument, deleteSkillDirectory, getSkillCanvasSettings } from '../storage';
import { rememberCanvasEditorContent, writeEditorFileWithMergeAsync } from '../services/canvas-editor-state';
import { getConfigValue } from '../config';
import { parseFrontmatter, serializeFrontmatter } from '../frontmatter';
import { getSkillsDir } from '../skill-watcher';
import { pickEmoji } from '../emoji-picker';
import { projectSkillSchedule } from '../services/scheduler';
import { localTimeZone, validateScheduleOptions } from '../services/skill-schedule-store';
import { clearSkillSchedule, getSkillSchedule, listScheduledRuns, migrateLegacySkillSchedule, saveSkillSchedule } from '../storage';
import { getAllMcpServers } from '../mcp';
import { notifyAllWindows } from '../notify';
import { invokeSkill } from '../skill-invocation';
import { WHIM_REPORT_CANVAS_ID } from '../canvas/sdk-canvas-provider';
import type { SkillFrontmatter, Skill, SkillInvocationInput, SkillScheduleFrequency } from '../../shared/types';
import type { ScheduleOptions } from '../../shared/skill-schedule';

/**
 * Resolve the report settings a skill declares on disk.
 *
 * These deliberately are not columns on the `skills` table: SKILL.md is the
 * source of truth for them, and a projection rebuilt from the event log has
 * never seen the file. Reading them at list time keeps the UI showing what the
 * run will actually do, including edits made in an editor outside whim.
 */
async function withCanvasSettings(skill: Skill): Promise<Skill> {
  const workspace = getConfigValue('workspace');
  const settings = workspace ? await getSkillCanvasSettings(workspace, skill, WHIM_REPORT_CANVAS_ID) : {};
  const schedule = workspace ? (await migrateLegacySkillSchedule(workspace, skill)) : null;
  if (!schedule) return { ...skill, ...settings };
  (await projectSkillSchedule(schedule));
  return {
    ...skill, ...settings, schedule_details: schedule,
    ...(schedule.output === 'canvas' && workspace
      ? { schedule_runs: (await listScheduledRuns(workspace, schedule.id)).slice(-100) }
      : {}),
    schedule: schedule.enabled ? schedule.frequency : null,
    schedule_time: schedule.enabled ? schedule.time : null,
    schedule_day: schedule.enabled ? schedule.day : null,
    next_run_at: schedule.enabled ? schedule.nextRunAt : null,
    last_run_at: schedule.lastRun?.startedAt ?? null,
  };
}

export function registerSkillHandlers(): void {
  registerIpcHandler('skill:list', async () => {
    if (!isInitialized()) return [];
    const skills = await listSkills();
    const result: Skill[] = [];
    for (let offset = 0; offset < skills.length; offset += 16) {
      result.push(...await Promise.all(skills.slice(offset, offset + 16).map(withCanvasSettings)));
    }
    return result;
  });

  registerIpcHandler('skill:read', async (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = (await getSkill(skillId));
    if (!skill) return { error: 'not_found' };

    try {
      const content = await readDocument(skill.filePath, workspace);
      rememberCanvasEditorContent(`__skill__${skillId}`, content);
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(content);
      return { frontmatter, body };
    } catch {
      return { error: 'read_failed' };
    }
  });

  registerIpcHandler('skill:write', async (_event, skillId: string, frontmatter: Record<string, unknown>, body: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = (await getSkill(skillId));
    if (!skill) return { error: 'not_found' };

    try {
      const content = serializeFrontmatter(frontmatter as SkillFrontmatter, body);
      return await writeEditorFileWithMergeAsync(`__skill__${skillId}`, skill.filePath, content, async (merged, expected) => {
        await writeDocument({ filePath: skill.filePath, root: workspace, content: merged, expected });
      });
    } catch {
      return { error: 'write_failed' };
    }
  });

  registerIpcHandler('skill:create', async (_event, name: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    // Slugify the name for the folder
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'new-skill';

    const skillsDir = getSkillsDir(workspace);
    const folderPath = path.join(skillsDir, slug);

    if (fs.existsSync(folderPath)) {
      return { error: 'already_exists' };
    }

    const content = serializeFrontmatter(
      { name, description: '' } as SkillFrontmatter,
      '\n'
    );
    const filePath = await createSkillDocument(workspace, slug, content);

    // The watcher will pick it up, but we can also index immediately
    const now = new Date().toISOString();
    const skill: Skill = {
      id: slug,
      name,
      description: '',
      emoji: pickEmoji(name, ''),
      folder: path.join('.agents/skills', slug),
      filePath,
      schedule: null,
      schedule_time: null,
      schedule_day: null,
      next_run_at: null,
      last_run_at: null,
      created_at: now,
      updated_at: now,
    };
    (await upsertSkill(skill));
    return skill;
  });

  registerIpcHandler('skill:delete', async (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return false;

    const skill = (await getSkill(skillId));
    if (!skill) return false;

    try {
      (await clearSkillSchedule(workspace, skillId));
      await deleteSkillDirectory(workspace, skill.folder);
      (await removeSkill(skillId));
      notifyAllWindows('skills:changed');
      return true;
    } catch (error) {
      console.error('[skills] Failed to delete skill:', error);
      return false;
    }
  });

  registerIpcHandler('skill:open-folder', async (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return;

    const skill = (await getSkill(skillId));
    if (!skill) return;

    shell.openPath(path.join(workspace, skill.folder));
  });

  registerIpcHandler('skill:create-from-prompt', async (_event, description: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const { launchQuickAgent } = await import('../agent-service');
    const skillsDir = getSkillsDir(workspace);

    // List existing skill slugs so the agent avoids collisions
    const existingSlugs = (await listSkills()).map(s => s.id);
    const existingNote = existingSlugs.length > 0
      ? `\nExisting skill folders (DO NOT overwrite these): ${existingSlugs.join(', ')}`
      : '';

    const systemPrompt = [
      'You are a skill template generator. The user will give you a short description of a skill they want to create.',
      'Your job is to:',
      '1. Choose a short, descriptive name for the skill (e.g. "Issue Triage", "PR Review", "Release Notes")',
      '2. Choose a unique kebab-case slug for the folder name (e.g. "issue-triage", "pr-review", "release-notes")',
      '3. Write a concise one-line description',
      '4. Write a detailed SKILL.md body with instructions for how an agent should perform this skill',
      '',
      `Create the skill folder and SKILL.md file inside: ${skillsDir}`,
      'The folder structure must be: {skills-dir}/{slug}/SKILL.md',
      existingNote,
      'IMPORTANT: Never overwrite an existing skill folder. Choose a unique slug.',
      '',
      'The SKILL.md file MUST have this exact format:',
      '```',
      '---',
      'name: <skill name>',
      "description: '<one-line description>'",
      '---',
      '',
      '<detailed instructions for the skill>',
      '```',
      '',
      'Create the folder and write the file. Do not ask for confirmation.',
    ].join('\n');

    const result = await launchQuickAgent(
      `${systemPrompt}\n\nUser description: ${description}`,
      workspace,
    );

    return result;
  });

  registerIpcHandler('skill:create-space', async (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const result = await invokeSkill({ skillId, run: false, source: 'skill-card' });
    return 'error' in result ? result : result.space;
  });

  registerIpcHandler('skill:launch', async (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const result = await invokeSkill({ skillId, run: true, source: 'skill-editor' });
    if (result.error) return { error: result.error };
    return 'space' in result ? result.space : result;
  });

  registerIpcHandler('skill:invoke', async (_event, input: SkillInvocationInput) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };
    if (!input || typeof input !== 'object' || typeof input.skillId !== 'string' || !input.skillId ||
        (input.intent !== undefined && typeof input.intent !== 'string') ||
        (input.run !== undefined && typeof input.run !== 'boolean') ||
        (input.preferredAgent !== undefined && input.preferredAgent !== null && typeof input.preferredAgent !== 'string')) {
      return { error: 'invalid_invocation' };
    }
    if (input.source !== undefined && !['side-panel', 'skill-card', 'skill-editor', 'api'].includes(input.source)) {
      return { error: 'invalid_source' };
    }
    // Scheduled context is main-process authority, never a renderer/API payload.
    return invokeSkill({
      skillId: input.skillId, intent: input.intent, run: input.run,
      preferredAgent: input.preferredAgent, source: input.source,
    });
  });

  registerIpcHandler('skill:schedule-sources', () => {
    return Object.keys(getAllMcpServers()).map(name => ({ name }));
  });

  registerIpcHandler('skill:set-schedule', async (_event, skillId: string, frequency: SkillScheduleFrequency, time: string, day: number | null, options?: ScheduleOptions) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = (await getSkill(skillId));
    if (!skill) return { error: 'not_found' };

    // Validate inputs to protect main process from arbitrary IPC payloads.
    const validFrequencies: SkillScheduleFrequency[] = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
    if (!validFrequencies.includes(frequency)) {
      return { error: 'invalid_frequency' };
    }
    if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      return { error: 'invalid_time' };
    }
    if (day !== null && (!Number.isInteger(day) || day < 0 || day > 6)) {
      return { error: 'invalid_day' };
    }
    // weekly/biweekly require a day; daily/weekdays/monthly ignore it.
    const normalizedDay = (frequency === 'weekly' || frequency === 'biweekly') ? day : null;

    const existing = (await getSkillSchedule(workspace, skillId));
    const activeSchedule = existing?.enabled ? existing : null;
    const effectiveOptions = options ?? {
      timeZone: activeSchedule?.timeZone ?? localTimeZone(),
      intent: activeSchedule?.intent ?? '',
      readOnlyServers: activeSchedule?.readOnlyServers ?? [],
    };
    try {
      validateScheduleOptions(effectiveOptions);
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'invalid_schedule_options' };
    }
    const configured = new Set(Object.keys(getAllMcpServers()));
    const retained = new Set(activeSchedule?.readOnlyServers ?? []);
    if (effectiveOptions.readOnlyServers.some(name => !configured.has(name) && !retained.has(name))) {
      return { error: 'invalid_read_only_servers' };
    }
    // Migration precedes timing edits so a legacy report never silently turns
    // into a read-only canvas digest, even before the scheduler's first tick.
    (await migrateLegacySkillSchedule(workspace, skill));
    const schedule = (await saveSkillSchedule(workspace, skillId, frequency, time, normalizedDay, effectiveOptions));
    (await projectSkillSchedule(schedule));

    return (await withCanvasSettings((await getSkill(skillId))!));
  });

  registerIpcHandler('skill:set-canvas', async (_event, skillId: string, canvas: string | null, spaceMode: 'new' | 'reuse' | null) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = (await getSkill(skillId));
    if (!skill) return { error: 'not_found' };

    // The canvas id lands in SKILL.md, which is read back at launch to decide
    // what the run may publish — so it is validated here rather than trusted.
    if (canvas !== null && (typeof canvas !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(canvas))) {
      return { error: 'invalid_canvas' };
    }
    if (spaceMode !== null && spaceMode !== 'new' && spaceMode !== 'reuse') {
      return { error: 'invalid_space_mode' };
    }

    try {
      const content = await readDocument(skill.filePath, workspace);
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(content);

      if (canvas === null) {
        delete frontmatter.canvas;
        delete frontmatter.space_mode;
      } else {
        // `canvas: true` is the spelling for the built-in report, and keeping it
        // means a skill the user never customised does not grow an id it would
        // have to keep in step with whim.
        frontmatter.canvas = canvas === WHIM_REPORT_CANVAS_ID ? true : canvas;
        if (spaceMode) frontmatter.space_mode = spaceMode;
        else delete frontmatter.space_mode;
      }

      await writeDocument({ filePath: skill.filePath, root: workspace, content: serializeFrontmatter(frontmatter, body), expected: content });
    } catch {
      return { error: 'write_failed' };
    }

    return (await withCanvasSettings((await getSkill(skillId))!));
  });

  registerIpcHandler('skill:clear-schedule', async (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = (await getSkill(skillId));
    if (!skill) return { error: 'not_found' };

    (await migrateLegacySkillSchedule(workspace, skill));
    (await clearSkillSchedule(workspace, skillId));
    (await updateSkillSchedule(skillId, null, null, null, null));

    return { success: true };
  });
}
