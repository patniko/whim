import * as fs from 'fs';
import * as path from 'path';
import { indexSkills, getStorageGeneration } from './storage';
import { notifyAllWindows } from './notify';
import { observeProducer } from './producer-tasks';

let watcher: fs.FSWatcher | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
export function getSkillsDir(root: string): string { return path.join(root, '.agents', 'skills'); }
export function ensureSkillsDir(root: string): void { fs.mkdirSync(getSkillsDir(root), { recursive: true }); }

export async function syncAllSkills(root: string): Promise<void> {
  const generation = getStorageGeneration();
  await indexSkills(root);
  if (generation === getStorageGeneration()) notifyAllWindows('skills:changed');
}

export async function startSkillWatcher(root: string): Promise<void> {
  stopSkillWatcher();
  const current = revision;
  const sync = async () => {
    if (current !== revision) return;
    await observeProducer(syncAllSkills(root));
  };
  await sync();
  if (current !== revision) return;
  watcher = fs.watch(getSkillsDir(root), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void sync().catch(error => console.error('[skill-watcher] Index failed:', error)); }, 500);
  });
  watcher.on('error', error => console.error('[skill-watcher] Watch failed:', error));
}

export function stopSkillWatcher(): void {
  revision++;
  if (timer) clearTimeout(timer);
  timer = undefined;
  watcher?.close();
  watcher = undefined;
}
