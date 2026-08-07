import { registerIpcHandler } from './registry';
import { shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { isInitialized, listSkills, getSkill, upsertSkill, removeSkill, updateSkillSchedule } from '../database';
import { getConfigValue } from '../config';
import { parseFrontmatter, serializeFrontmatter } from '../frontmatter';
import { getSkillsDir, syncAllSkills } from '../skill-watcher';
import { pickEmoji } from '../emoji-picker';
import { computeNextRunAt } from '../services/scheduler';
import { invokeSkill } from '../skill-invocation';
import { WHIM_REPORT_CANVAS_ID } from '../canvas/sdk-canvas-provider';
import { loadSkillCanvasDefinition } from '../canvas/skill-canvas-template';
import type { SkillFrontmatter, Skill, SkillInvocationInput, SkillScheduleFrequency } from '../../shared/types';

const SKILL_FILE = 'SKILL.md';

/**
 * Resolve the report settings a skill declares on disk.
 *
 * These deliberately are not columns on the `skills` table: SKILL.md is the
 * source of truth for them, and a projection rebuilt from the event log has
 * never seen the file. Reading them at list time keeps the UI showing what the
 * run will actually do, including edits made in an editor outside whim.
 */
function readCanvasSettings(skill: Skill): Pick<Skill, 'canvas' | 'space_mode' | 'canvas_template'> {
  let frontmatter: SkillFrontmatter | null = null;
  try {
    frontmatter = parseFrontmatter<SkillFrontmatter>(fs.readFileSync(skill.filePath, 'utf-8')).frontmatter;
  } catch {
    frontmatter = null;
  }

  const raw = frontmatter?.canvas;
  let canvas: string | null = null;
  if (raw === true || raw === 'true') canvas = WHIM_REPORT_CANVAS_ID;
  else if (typeof raw === 'string' && raw.trim() && raw.trim() !== 'false') canvas = raw.trim();

  const modeRaw = frontmatter?.space_mode;
  const space_mode = modeRaw === 'new' || modeRaw === 'reuse' ? modeRaw : null;

  const workspace = getConfigValue('workspace');
  let canvas_template: Skill['canvas_template'] = null;
  if (workspace) {
    try {
      const definition = loadSkillCanvasDefinition(workspace, skill.id);
      if (definition) canvas_template = { id: definition.templateId, displayName: definition.displayName };
    } catch {
      canvas_template = null;
    }
  }

  return { canvas, space_mode, canvas_template };
}

function withCanvasSettings(skill: Skill): Skill {
  return { ...skill, ...readCanvasSettings(skill) };
}

export function registerSkillHandlers(): void {
  registerIpcHandler('skill:list', () => {
    if (!isInitialized()) return [];
    return listSkills().map(withCanvasSettings);
  });

  registerIpcHandler('skill:read', (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = getSkill(skillId);
    if (!skill) return { error: 'not_found' };

    try {
      const content = fs.readFileSync(skill.filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(content);
      return { frontmatter, body };
    } catch {
      return { error: 'read_failed' };
    }
  });

  registerIpcHandler('skill:write', (_event, skillId: string, frontmatter: Record<string, unknown>, body: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = getSkill(skillId);
    if (!skill) return { error: 'not_found' };

    try {
      const content = serializeFrontmatter(frontmatter as SkillFrontmatter, body);
      fs.writeFileSync(skill.filePath, content, 'utf-8');
      // The file watcher will pick up the change and re-index
      return { success: true };
    } catch {
      return { error: 'write_failed' };
    }
  });

  registerIpcHandler('skill:create', (_event, name: string) => {
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

    fs.mkdirSync(folderPath, { recursive: true });

    const filePath = path.join(folderPath, SKILL_FILE);
    const content = serializeFrontmatter(
      { name, description: '' } as SkillFrontmatter,
      '\n'
    );
    fs.writeFileSync(filePath, content, 'utf-8');

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
    upsertSkill(skill);
    return skill;
  });

  registerIpcHandler('skill:delete', (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return false;

    const skill = getSkill(skillId);
    if (!skill) return false;

    const folderPath = path.join(workspace, skill.folder);
    try {
      fs.rmSync(folderPath, { recursive: true, force: true });
      removeSkill(skillId);
      return true;
    } catch {
      return false;
    }
  });

  registerIpcHandler('skill:open-folder', (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return;

    const skill = getSkill(skillId);
    if (!skill) return;

    shell.openPath(path.join(workspace, skill.folder));
  });

  registerIpcHandler('skill:create-from-prompt', async (_event, description: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const { launchQuickAgent } = await import('../agent-service');
    const skillsDir = getSkillsDir(workspace);

    // List existing skill slugs so the agent avoids collisions
    const existingSlugs = listSkills().map(s => s.id);
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
    return 'space' in result ? result.space : result;
  });

  registerIpcHandler('skill:invoke', async (_event, input: SkillInvocationInput) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };
    return invokeSkill(input);
  });

  registerIpcHandler('skill:set-schedule', (_event, skillId: string, frequency: SkillScheduleFrequency, time: string, day: number | null) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = getSkill(skillId);
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

    const nextRunAt = computeNextRunAt(frequency, time, normalizedDay);
    updateSkillSchedule(skillId, frequency, time, normalizedDay, nextRunAt);

    // Also update the SKILL.md frontmatter so schedule is persisted to disk
    try {
      const content = fs.readFileSync(skill.filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(content);
      frontmatter.schedule = frequency;
      frontmatter.schedule_time = time;
      if (normalizedDay !== null) {
        frontmatter.schedule_day = normalizedDay;
      } else {
        delete frontmatter.schedule_day;
      }
      const updated = serializeFrontmatter(frontmatter, body);
      fs.writeFileSync(skill.filePath, updated, 'utf-8');
    } catch {
      // DB is updated even if frontmatter write fails
    }

    return withCanvasSettings(getSkill(skillId)!);
  });

  registerIpcHandler('skill:set-canvas', (_event, skillId: string, canvas: string | null, spaceMode: 'new' | 'reuse' | null) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = getSkill(skillId);
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
      const content = fs.readFileSync(skill.filePath, 'utf-8');
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

      fs.writeFileSync(skill.filePath, serializeFrontmatter(frontmatter, body), 'utf-8');
    } catch {
      return { error: 'write_failed' };
    }

    return withCanvasSettings(getSkill(skillId)!);
  });

  registerIpcHandler('skill:clear-schedule', (_event, skillId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !isInitialized()) return { error: 'no_workspace' };

    const skill = getSkill(skillId);
    if (!skill) return { error: 'not_found' };

    updateSkillSchedule(skillId, null, null, null, null);

    // Also remove schedule from SKILL.md frontmatter
    try {
      const content = fs.readFileSync(skill.filePath, 'utf-8');
      const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(content);
      delete frontmatter.schedule;
      delete frontmatter.schedule_time;
      delete frontmatter.schedule_day;
      const updated = serializeFrontmatter(frontmatter, body);
      fs.writeFileSync(skill.filePath, updated, 'utf-8');
    } catch {
      // DB is updated even if frontmatter write fails
    }

    return { success: true };
  });
}
