import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

// Mock Electron and heavy dependencies before importing
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, getName: () => 'test', on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../ai', () => ({}));
vi.mock('../config', () => ({
  getConfig: () => ({}),
  setConfig: vi.fn(),
  loadConfig: vi.fn(),
}));
vi.mock('./mcp-server-manager', () => ({
  getAllMcpServers: () => ({}),
}));
vi.mock('./agent-notifier', () => ({}));

vi.mock('../database', () => ({
  listSkills: vi.fn(),
  getDatabase: vi.fn(),
  initDatabase: vi.fn(),
}));

import { resolveLinkedSkillConfig } from './sdk-runner';
import { listSkills } from '../database';

const mockedListSkills = vi.mocked(listSkills);

function makeSkill(id: string, name: string) {
  return {
    id,
    name,
    description: '',
    emoji: '🔧',
    folder: id,
    filePath: `/workspace/.agents/skills/${id}/SKILL.md`,
    schedule: null,
    schedule_time: null,
    schedule_day: null,
    next_run_at: null,
    last_run_at: null,
    created_at: '',
    updated_at: '',
  };
}

describe('resolveLinkedSkillConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns undefined when no frontmatter exists', () => {
    const result = resolveLinkedSkillConfig('# Hello world', '/workspace');
    expect(result).toBeUndefined();
  });

  it('returns undefined when frontmatter has no skills field', () => {
    const content = `---\nname: My Canvas\n---\n# Hello`;
    const result = resolveLinkedSkillConfig(content, '/workspace');
    expect(result).toBeUndefined();
  });

  it('returns undefined when skills array is empty', () => {
    const content = `---\nskills: []\n---\n# Hello`;
    const result = resolveLinkedSkillConfig(content, '/workspace');
    expect(result).toBeUndefined();
  });

  it('returns skillDirectories and disabledSkills for linked skills', () => {
    mockedListSkills.mockReturnValue([
      makeSkill('pdf-processing', 'PDF Processing'),
      makeSkill('code-review', 'Code Review'),
      makeSkill('writing', 'Writing Assistant'),
    ] as any);

    const content = `---\nskills:\n  - pdf-processing\n  - writing\n---\n# Hello`;
    const result = resolveLinkedSkillConfig(content, '/workspace');

    expect(result).toBeDefined();
    expect(result!.skillDirectories).toEqual([path.join('/workspace', '.agents', 'skills')]);
    // Only the unlinked skill should be disabled
    expect(result!.disabledSkills).toEqual(['Code Review']);
  });

  it('handles inline YAML array syntax', () => {
    mockedListSkills.mockReturnValue([
      makeSkill('pdf-processing', 'PDF Processing'),
      makeSkill('code-review', 'Code Review'),
    ] as any);

    const content = `---\nskills: [pdf-processing]\n---\n# Hello`;
    const result = resolveLinkedSkillConfig(content, '/workspace');

    expect(result).toBeDefined();
    expect(result!.disabledSkills).toEqual(['Code Review']);
  });

  it('disables all skills when linked IDs dont match any known skill', () => {
    mockedListSkills.mockReturnValue([
      makeSkill('pdf-processing', 'PDF Processing'),
    ] as any);

    const content = `---\nskills:\n  - nonexistent-skill\n---\n# Hello`;
    const result = resolveLinkedSkillConfig(content, '/workspace');

    expect(result).toBeDefined();
    // The linked ID doesn't match any known skill, so all known skills are disabled
    expect(result!.disabledSkills).toEqual(['PDF Processing']);
  });

  it('returns empty disabledSkills when all skills are linked', () => {
    mockedListSkills.mockReturnValue([
      makeSkill('a', 'Skill A'),
      makeSkill('b', 'Skill B'),
    ] as any);

    const content = `---\nskills: [a, b]\n---\n# Hello`;
    const result = resolveLinkedSkillConfig(content, '/workspace');

    expect(result).toBeDefined();
    expect(result!.disabledSkills).toEqual([]);
  });
});
