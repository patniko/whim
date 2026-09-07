/**
 * Per-space activity log — writes to {spaceFolder}/.whim/events.jsonl
 * Append-only log for debugging agent activity on a canvas.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveSpaceFolder } from './workspace';

export interface SpaceActivityEvent {
  ts: string;
  type: string;
  [key: string]: any;
}

/** Get the activity log path for a space folder. */
export function getSpaceActivityLogPath(workspaceRoot: string, spaceFolder: string): string {
  const folderRoot = resolveSpaceFolder(workspaceRoot, spaceFolder);
  return path.join(folderRoot, '.whim', 'events.jsonl');
}

/** Append an event to the per-space activity log. */
export function appendSpaceActivity(workspaceRoot: string, spaceFolder: string, type: string, data: Record<string, any>): void {
  if (!workspaceRoot || !spaceFolder) throw new Error('Activity log requires a workspace and space folder');

  const folderRoot = resolveSpaceFolder(workspaceRoot, spaceFolder);
  const logDir = path.join(folderRoot, '.whim');
  const logPath = path.join(logDir, 'events.jsonl');

    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const event: SpaceActivityEvent = {
      ts: new Date().toISOString(),
      type,
      ...data,
    };
    const line = JSON.stringify(event) + '\n';
    const fd = fs.openSync(logPath, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
}

/** Read all events from the per-space activity log. */
export function readSpaceActivityLog(workspaceRoot: string, spaceFolder: string): SpaceActivityEvent[] {
  const logPath = getSpaceActivityLogPath(workspaceRoot, spaceFolder);
  if (!fs.existsSync(logPath)) return [];

  try {
    const content = fs.readFileSync(logPath, 'utf-8');
    const events: SpaceActivityEvent[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Skip corrupt lines
      }
    }
    return events;
  } catch {
    return [];
  }
}
