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
import * as path from 'path';

interface WatchEntry {
  watcher: fs.FSWatcher;
  canvasPath: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** MD5 of the last content written by the editor (to ignore self-writes). */
  selfWriteHash: string | null;
  /** MD5 of the last content seen on disk (to avoid duplicate notifications). */
  lastSeenHash: string | null;
  onChange: (content: string) => void | Promise<void>;
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
  onChange: (content: string) => void | Promise<void>,
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
    watcher = fs.watch(path.dirname(canvasPath), { persistent: false });
  } catch (error) {
    console.error('[canvas-watcher] Unable to watch document directory:', error);
    throw error;
  }

  const entry: WatchEntry = {
    watcher,
    canvasPath,
    debounceTimer: null,
    selfWriteHash: null,
    lastSeenHash,
    onChange,
  };

  watcher.on('change', (_event, filename) => {
    if (filename && filename.toString() !== path.basename(canvasPath)) return;
    // Debounce rapid changes (agents may write multiple times quickly)
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void handleFileChange(entry).catch(error => console.error('[canvas-watcher] Refresh failed:', error));
    }, DEBOUNCE_MS);
  });

  watcher.on('error', error => {
    console.error('[canvas-watcher] Document watcher failed:', error);
    stopWatching(spaceId);
  });

  watches.set(spaceId, entry);
}

async function handleFileChange(entry: WatchEntry): Promise<void> {
  let content: string;
  try {
    content = await fs.promises.readFile(entry.canvasPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (![...watches.values()].includes(entry)) return;

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
  await entry.onChange(content);
}

/** Sync completion waits for disk-authoritative updates, without changing editor bases. */
export async function refreshWatchedCanvases(): Promise<void> {
  for (const entry of watches.values()) await handleFileChange(entry);
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
export function stopAllWatchers(): () => Promise<void> {
  const suspended = [...watches.entries()];
  for (const spaceId of watches.keys()) {
    stopWatching(spaceId);
  }
  return async () => {
    for (const [spaceId, previous] of suspended) {
      startWatching(spaceId, previous.canvasPath, previous.onChange);
      const restored = watches.get(spaceId)!;
      restored.lastSeenHash = previous.lastSeenHash;
      restored.selfWriteHash = previous.selfWriteHash;
    }
    await refreshWatchedCanvases();
  };
}

/** Check if a space is currently being watched. (Exposed for testing.) */
export function isWatching(spaceId: string): boolean {
  return watches.has(spaceId);
}
