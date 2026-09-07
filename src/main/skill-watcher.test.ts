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
vi.mock('./storage', async () => ({
  indexSkills: (await import('./storage-index')).indexSkills,
  getStorageGeneration: () => 0,
}));

// Mock workspace
vi.mock('./workspace', () => ({
  readCanvas: vi.fn(() => ''),
}));

import { initDatabase, listSkills } from './database';
import { syncAllSkills, getSkillsDir, ensureSkillsDir } from './skill-watcher';

let testDir: string;
let wsRoot: string;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-watcher-test-'));
  wsRoot = path.join(testDir, 'workspace');
  fs.mkdirSync(wsRoot, { recursive: true });

  const dbPath = path.join(testDir, 'test.db');
  const logPath = path.join(testDir, 'events');
  initDatabase(dbPath, logPath);
}

function createSkillOnDisk(name: string, frontmatter: string = '', body: string = '') {
  const dir = path.join(wsRoot, '.agents', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  const content = frontmatter ? `---\n${frontmatter}\n---\n${body}` : body;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

afterEach(() => {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('skill-watcher', () => {
  describe('getSkillsDir', () => {
    it('returns the correct skills directory path', () => {
      expect(getSkillsDir('/ws')).toBe(path.join('/ws', '.agents', 'skills'));
    });
  });

  describe('ensureSkillsDir', () => {
    it('creates the skills directory if it does not exist', () => {
      const dir = getSkillsDir(wsRoot);
      expect(fs.existsSync(dir)).toBe(false);
      ensureSkillsDir(wsRoot);
      expect(fs.existsSync(dir)).toBe(true);
    });

    it('does not error if directory already exists', () => {
      ensureSkillsDir(wsRoot);
      ensureSkillsDir(wsRoot); // should not throw
    });
  });

  describe('syncAllSkills', () => {
    it('indexes skills from disk into the database', async () => {
      createSkillOnDisk('pdf-processing', 'name: PDF Processing\ndescription: Handle PDFs');
      createSkillOnDisk('code-review', 'name: Code Review\ndescription: Review code');

      (await syncAllSkills(wsRoot));

      const skills = listSkills();
      expect(skills).toHaveLength(2);
      const names = skills.map(s => s.name).sort();
      expect(names).toEqual(['Code Review', 'PDF Processing']);

      // Each skill should have an auto-generated emoji
      for (const skill of skills) {
        expect(skill.emoji).toBeDefined();
        expect(skill.emoji.length).toBeGreaterThan(0);
      }
      // PDF skill should get the document emoji
      const pdf = skills.find(s => s.id === 'pdf-processing')!;
      expect(pdf.emoji).toBe('📄');
    });

    it('uses folder name as fallback when no name in frontmatter', async () => {
      createSkillOnDisk('my-skill', '', '# Just a body');

      (await syncAllSkills(wsRoot));

      const skills = listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('my-skill');
    });

    it('removes skills from DB that no longer exist on disk', async () => {
      createSkillOnDisk('keep-me', 'name: Keep Me');
      createSkillOnDisk('remove-me', 'name: Remove Me');

      (await syncAllSkills(wsRoot));
      expect(listSkills()).toHaveLength(2);

      // Remove one from disk
      fs.rmSync(path.join(wsRoot, '.agents', 'skills', 'remove-me'), { recursive: true });
      (await syncAllSkills(wsRoot));

      const skills = listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].id).toBe('keep-me');
    });

    it('skips non-directory entries in the skills folder', async () => {
      ensureSkillsDir(wsRoot);
      // Create a regular file (not a directory)
      fs.writeFileSync(path.join(wsRoot, '.agents', 'skills', 'not-a-dir.txt'), 'hello');
      createSkillOnDisk('real-skill', 'name: Real Skill');

      (await syncAllSkills(wsRoot));
      expect(listSkills()).toHaveLength(1);
    });

    it('skips folders without SKILL.md', async () => {
      const dir = path.join(wsRoot, '.agents', 'skills', 'empty-skill');
      fs.mkdirSync(dir, { recursive: true });
      // No SKILL.md inside

      (await syncAllSkills(wsRoot));
      expect(listSkills()).toHaveLength(0);
    });

    it('handles missing skills directory gracefully', async () => {
      // Don't create the skills dir
      (await syncAllSkills(wsRoot));
      expect(listSkills()).toHaveLength(0);
    });

    it('updates DB when skill content changes', async () => {
      createSkillOnDisk('my-skill', 'name: Original Name');
      (await syncAllSkills(wsRoot));
      expect(listSkills()[0].name).toBe('Original Name');

      // Update the file
      const filePath = path.join(wsRoot, '.agents', 'skills', 'my-skill', 'SKILL.md');
      fs.writeFileSync(filePath, '---\nname: Updated Name\n---\nBody', 'utf-8');
      (await syncAllSkills(wsRoot));
      expect(listSkills()[0].name).toBe('Updated Name');
    });

    it('uses emoji from frontmatter when provided', async () => {
      createSkillOnDisk('custom-emoji', 'name: My Skill\ndescription: Does things\nemoji: "🎸"');
      (await syncAllSkills(wsRoot));

      const skills = listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].emoji).toBe('🎸');
    });

    it('auto-generates emoji when not specified in frontmatter', async () => {
      createSkillOnDisk('deploy-helper', 'name: Deploy Helper\ndescription: Automate deployments');
      (await syncAllSkills(wsRoot));

      const skills = listSkills();
      expect(skills).toHaveLength(1);
      expect(skills[0].emoji).toBe('🚀');
    });
  });
});
