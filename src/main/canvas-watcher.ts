/**
 * Watches canvas.md files for external modifications (e.g. by agents).
 *
 * When a canvas is open in the editor and agents are running, the watcher
 * detects on-disk changes and fires a callback so the renderer can merge
 * them into the editor state without clobbering user edits.
 *
 * Self-write tracking: the editor writes to canvas.md via canvas:write IPC.
 * Before each write, call `markSelfWrite` with the content being written so
 * the watcher knows to ignore the resulting fs event.
 */

import * as fs from 'fs';
import * as crypto from 'crypto';

interface WatchEntry {
  watcher: fs.FSWatcher;
  canvasPath: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** MD5 of the last content written by the editor (to ignore self-writes). */
  selfWriteHash: string | null;
  /** MD5 of the last content seen on disk (to avoid duplicate notifications). */
  lastSeenHash: string | null;
  onChange: (content: string) => void;
}

const watches = new Map<string, WatchEntry>();

const DEBOUNCE_MS = 250;

function contentHash(content: string): string {
  return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Start watching a canvas file for external changes.
 * If already watching this spaceId, the previous watcher is stopped first.
 */
export function startWatching(
  spaceId: string,
  canvasPath: string,
  onChange: (content: string) => void,
): void {
  stopWatching(spaceId);

  // Snapshot current content hash so we don't fire for the initial state
  let lastSeenHash: string | null = null;
  try {
    const content = fs.readFileSync(canvasPath, 'utf-8');
    lastSeenHash = contentHash(content);
  } catch { /* file may not exist yet */ }

  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(canvasPath, { persistent: false });
  } catch {
    // File doesn't exist yet — nothing to watch
    return;
  }

  const entry: WatchEntry = {
    watcher,
    canvasPath,
    debounceTimer: null,
    selfWriteHash: null,
    lastSeenHash,
    onChange,
  };

  watcher.on('change', () => {
    // Debounce rapid changes (agents may write multiple times quickly)
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      handleFileChange(entry);
    }, DEBOUNCE_MS);
  });

  watcher.on('error', () => {
    // Silently stop on error (file deleted, permissions, etc.)
    stopWatching(spaceId);
  });

  watches.set(spaceId, entry);
}

function handleFileChange(entry: WatchEntry): void {
  let content: string;
  try {
    content = fs.readFileSync(entry.canvasPath, 'utf-8');
  } catch {
    return; // File disappeared — ignore
  }

  const hash = contentHash(content);

  // Skip if content hasn't actually changed
  if (hash === entry.lastSeenHash) return;

  // Skip if this is our own write
  if (hash === entry.selfWriteHash) {
    entry.selfWriteHash = null;
    entry.lastSeenHash = hash;
    return;
  }

  entry.lastSeenHash = hash;
  entry.onChange(content);
}

/** Stop watching a canvas file. */
export function stopWatching(spaceId: string): void {
  const entry = watches.get(spaceId);
  if (!entry) return;

  if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
  try { entry.watcher.close(); } catch { /* already closed */ }
  watches.delete(spaceId);
}

/**
 * Record the content hash of a write originating from the editor,
 * so the watcher ignores the resulting fs event.
 */
export function markSelfWrite(spaceId: string, content: string): void {
  const entry = watches.get(spaceId);
  if (!entry) return;
  entry.selfWriteHash = contentHash(content);
}

export function clearSelfWrite(spaceId: string): void {
  const entry = watches.get(spaceId);
  if (entry) entry.selfWriteHash = null;
}

/** Stop all active watchers. Called on app shutdown. */
export function stopAllWatchers(): void {
  for (const spaceId of watches.keys()) {
    stopWatching(spaceId);
  }
}

/** Check if a space is currently being watched. (Exposed for testing.) */
export function isWatching(spaceId: string): boolean {
  return watches.has(spaceId);
}
