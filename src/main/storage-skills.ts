import * as fs from 'fs';
import * as path from 'path';
import { loadSkillCanvasDefinition } from './canvas/skill-canvas-template';
import { parseFrontmatter } from './frontmatter';
import { readDocument, writeDocument } from './storage-documents';
import { syncDirectory } from './persistence-snapshot';
import { isPathContainedBy } from './workspace';
import type { Skill, SkillFrontmatter } from '../shared/types';

function skillDirectory(workspace: string, folder: string): string {
  const root = path.join(workspace, '.agents', 'skills');
  const directory = path.resolve(workspace, folder);
  if (directory === root || !isPathContainedBy(root, directory) || !isPathContainedBy(workspace, directory)) throw new Error('Invalid skill directory');
  return directory;
}

export function createSkillDocument(workspace: string, slug: string, content: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error('Invalid skill name');
  const directory = skillDirectory(workspace, path.join('.agents', 'skills', slug));
  for (const parent of [path.join(workspace, '.agents'), path.dirname(directory)]) {
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent);
      syncDirectory(path.dirname(parent));
    }
  }
  fs.mkdirSync(directory);
  syncDirectory(path.dirname(directory));
  const filePath = path.join(directory, 'SKILL.md');
  writeDocument({ root: workspace, filePath, content, expected: undefined });
  return filePath;
}

export function deleteSkillDirectory(workspace: string, folder: string): void {
  const directory = skillDirectory(workspace, folder);
  fs.rmSync(directory, { recursive: true, force: true });
  syncDirectory(path.dirname(directory));
}

export function getSkillCanvasSettings(workspace: string, skill: Skill, defaultCanvasId: string): Pick<Skill, 'canvas' | 'space_mode' | 'canvas_template'> {
  const { frontmatter } = parseFrontmatter<SkillFrontmatter>(readDocument(skill.filePath, workspace));
  const raw = frontmatter.canvas;
  const canvas = raw === true || raw === 'true' ? defaultCanvasId
    : typeof raw === 'string' && raw.trim() && raw.trim() !== 'false' ? raw.trim() : null;
  const space_mode = frontmatter.space_mode === 'new' || frontmatter.space_mode === 'reuse' ? frontmatter.space_mode : null;
  const definition = loadSkillCanvasDefinition(workspace, skill.id);
  return { canvas, space_mode, canvas_template: definition ? { id: definition.templateId, displayName: definition.displayName } : null };
}
