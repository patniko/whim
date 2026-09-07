import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock electron
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/electron-path' },
  BrowserWindow: { getAllWindows: () => [] },
}));

// Mock eventlog
vi.mock('./eventlog', () => ({
  appendEvent: vi.fn(),
  replayLog: vi.fn(),
  recoverLogTails: vi.fn(),
}));

// Mock workspace
vi.mock('./workspace', () => ({
  readCanvas: vi.fn(() => ''),
}));

import { initDatabase, listSkills, upsertSkill, removeSkill, getSkill } from './database';
import type { Skill } from '../shared/types';

let testDir: string;

function freshDb() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-db-test-'));
  const dbPath = path.join(testDir, 'test.db');
  const logPath = path.join(testDir, 'events');
  initDatabase(dbPath, logPath);
}

beforeEach(() => {
  vi.clearAllMocks();
  freshDb();
});

afterEach(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  const now = new Date().toISOString();
  return {
    id: 'test-skill',
    name: 'Test Skill',
    description: 'A test skill',
    emoji: '🧪',
    folder: '.agents/skills/test-skill',
    filePath: '/ws/.agents/skills/test-skill/SKILL.md',
    schedule: null,
    schedule_time: null,
    schedule_day: null,
    next_run_at: null,
    last_run_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe('Skill DB operations', () => {
  it('upsertSkill inserts a new skill', () => {
    upsertSkill(makeSkill());
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('test-skill');
    expect(skills[0].name).toBe('Test Skill');
  });

  it('upsertSkill updates an existing skill', () => {
    upsertSkill(makeSkill());
    upsertSkill(makeSkill({ name: 'Updated Name', description: 'Updated desc' }));
    const skills = listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe('Updated Name');
    expect(skills[0].description).toBe('Updated desc');
  });

  it('removeSkill deletes a skill', () => {
    upsertSkill(makeSkill());
    expect(listSkills()).toHaveLength(1);
    removeSkill('test-skill');
    expect(listSkills()).toHaveLength(0);
  });

  it('getSkill returns a skill by id', () => {
    upsertSkill(makeSkill());
    const skill = getSkill('test-skill');
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('Test Skill');
  });

  it('getSkill returns null for unknown id', () => {
    expect(getSkill('nonexistent')).toBeNull();
  });

  it('listSkills returns all skills sorted by name', () => {
    upsertSkill(makeSkill({ id: 'z-skill', name: 'Zebra' }));
    upsertSkill(makeSkill({ id: 'a-skill', name: 'Apple' }));
    upsertSkill(makeSkill({ id: 'm-skill', name: 'Mango' }));
    const skills = listSkills();
    expect(skills.map(s => s.name)).toEqual(['Apple', 'Mango', 'Zebra']);
  });

  it('listSkills maps folder_path and file_path to folder and filePath', () => {
    upsertSkill(makeSkill());
    const skill = listSkills()[0];
    expect(skill.folder).toBe('.agents/skills/test-skill');
    expect(skill.filePath).toBe('/ws/.agents/skills/test-skill/SKILL.md');
  });
});
