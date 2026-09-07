import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter';
import { upsertSkill, removeSkill, listSkills, getSkill } from './database';
import { pickEmoji } from './emoji-picker';
import type { Skill, SkillFrontmatter, SkillScheduleFrequency } from '../shared/types';

const SKILLS_DIR = '.agents/skills';
const SKILL_FILE = 'SKILL.md';
const metadata = new Map<string, { size: number; mtimeMs: number; skill: Skill }>();

/** Get the absolute path to the skills directory. */
export function getSkillsDir(wsRoot: string): string {
  return path.join(wsRoot, SKILLS_DIR);
}

/** Ensure the .agents/skills/ directory exists. */
export function ensureSkillsDir(wsRoot: string): void {
  const dir = getSkillsDir(wsRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Parse a single skill folder into a Skill object. Returns null if SKILL.md is missing/invalid. */
function parseSkillFolder(wsRoot: string, folderName: string): Skill | null {
  const folderPath = path.join(wsRoot, SKILLS_DIR, folderName);
  const filePath = path.join(folderPath, SKILL_FILE);

  if (!fs.existsSync(filePath)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const cached = metadata.get(filePath);
  if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.skill;
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const { frontmatter } = parseFrontmatter<SkillFrontmatter>(content);

  const name = frontmatter.name || folderName;
  const description = frontmatter.description || '';
  const emoji = typeof frontmatter.emoji === 'string' && frontmatter.emoji
    ? frontmatter.emoji
    : pickEmoji(name, description);

  // Parse schedule fields from frontmatter
  const validFrequencies: SkillScheduleFrequency[] = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
  const schedule = typeof frontmatter.schedule === 'string' && validFrequencies.includes(frontmatter.schedule as SkillScheduleFrequency)
    ? frontmatter.schedule as SkillScheduleFrequency
    : null;
  const schedule_time = typeof frontmatter.schedule_time === 'string' && /^\d{2}:\d{2}$/.test(frontmatter.schedule_time)
    ? frontmatter.schedule_time
    : null;
  const schedule_day = typeof frontmatter.schedule_day === 'number' && frontmatter.schedule_day >= 0 && frontmatter.schedule_day <= 6
    ? frontmatter.schedule_day
    : null;

  const skill: Skill = {
    id: folderName,
    name,
    description,
    emoji,
    folder: path.join(SKILLS_DIR, folderName),
    filePath,
    schedule,
    schedule_time,
    schedule_day,
    next_run_at: null,
    last_run_at: null,
    created_at: stat.birthtime.toISOString(),
    updated_at: stat.mtime.toISOString(),
  };
  metadata.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, skill });
  return skill;
}

/** Scan all skill folders and sync DB state. */
export function indexSkills(wsRoot: string): void {
  let cursor: string | undefined;
  do { cursor = indexSkillsBatch(wsRoot, cursor).cursor; } while (cursor);
}

export function indexSkillsBatch(wsRoot: string, cursor?: string): { cursor?: string } {
  const skillsDir = getSkillsDir(wsRoot);
  const entries = fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).sort() : [];
  const batch = entries.filter(entry => cursor === undefined || entry > cursor).slice(0, 16);
  for (const entry of batch) {
    const entryPath = path.join(skillsDir, entry);
    try {
      if (!fs.statSync(entryPath).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    const skill = parseSkillFolder(wsRoot, entry);
    if (skill) {
      const existing = getSkill(skill.id);
      if (!existing || existing.updated_at !== skill.updated_at || existing.filePath !== skill.filePath) upsertSkill(skill);
    } else {
      removeSkill(entry);
    }
  }
  const last = batch[batch.length - 1];
  if (last !== undefined && entries.some(entry => entry > last)) return { cursor: last };

  // Remove skills from DB that no longer exist on disk
  const foundIds = new Set(entries);
  const existing = listSkills();
  for (const skill of existing) {
    if (!foundIds.has(skill.id)) {
      removeSkill(skill.id);
    }
  }

  for (const file of metadata.keys()) {
    if (!file.startsWith(skillsDir + path.sep) || !foundIds.has(path.basename(path.dirname(file)))) metadata.delete(file);
  }
  return {};
}
