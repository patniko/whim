/**
 * Background compaction — fold old segments into snapshot.jsonl.
 *
 * The rotated event log under `<whim>/events/` accumulates 25 MB
 * segments indefinitely. After a few months a heavy user's history is
 * spread across dozens of segments, all of which need to be read on
 * cold rebuild. This module folds anything older than the keep window
 * (default 30 days) into a single materialised snapshot at
 * `<whim>/events/snapshot.jsonl`, then deletes the cold segments and
 * the side files of subagents that aged out.
 *
 * Multi-client safety:
 *   • An advisory lock file (`.compacting.lock`) protects against two
 *     processes on the same machine compacting concurrently.
 *   • Cross-machine via git: compaction is deterministic — two
 *     clients producing snapshots from the same inputs create
 *     equivalent files, so a git merge picks one and we re-run on the
 *     next launch if anything was missed.
 *
 * Anything inside the keep window stays as line-by-line events for
 * full git-diff fidelity. The user is guaranteed at least
 * `KEEP_WINDOW_MS` of high-fidelity history.
 */
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { listLogFiles, SNAPSHOT_FILENAME, LOG_ROOT_DIRNAME } from './log-store';
import { replayFile } from './eventlog';
import { deleteContent, getContentDir } from './subagent-content-store';

/** Anything older than this is eligible to be folded into the snapshot. */
export const KEEP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Lock-file name (sibling of snapshot.jsonl inside the events tree). */
export const LOCK_FILENAME = '.compacting.lock';

/** A lock held longer than this is considered abandoned and reclaimed. */
export const LOCK_STALE_MS = 10 * 60 * 1000;

export interface CompactionResult {
  /** True when the lock was acquired and a snapshot was attempted. */
  ran: boolean;
  /** Reason for an early exit; useful for diagnostics + UI surfacing. */
  reason?: 'locked' | 'nothing-to-compact' | 'no-segments' | 'write-failed';
  /** Number of cold segments folded into the snapshot. */
  compactedSegments?: number;
  /** Number of subagent side files garbage-collected. */
  removedSideFiles?: number;
}

/**
 * Run compaction on `logRoot`. Cheap to call: when no segments are
 * cold (typical for new workspaces) it returns immediately without
 * touching the disk beyond a stat call.
 *
 * `now` is overridable for tests. `keepWindowMs` defaults to
 * KEEP_WINDOW_MS; callers might tighten it in test environments.
 */
export function compactOldSegments(
  logRoot: string,
  options: { now?: Date; keepWindowMs?: number } = {},
): CompactionResult {
  const now = options.now ?? new Date();
  const keepWindow = options.keepWindowMs ?? KEEP_WINDOW_MS;
  const cutoff = now.getTime() - keepWindow;

  if (!fs.existsSync(logRoot)) return { ran: false, reason: 'no-segments' };

  const allFiles = listLogFiles(logRoot);
  // Snapshot file is always re-read into the new snapshot; segments are
  // candidates for cold-folding.
  const snapshotPath = path.join(logRoot, SNAPSHOT_FILENAME);
  const segments = allFiles.filter((f) => f !== snapshotPath);

  const coldSegments = segments.filter((seg) => isSegmentCold(seg, cutoff));
  if (coldSegments.length === 0) {
    return { ran: false, reason: 'nothing-to-compact' };
  }

  if (!acquireLock(logRoot)) {
    return { ran: false, reason: 'locked' };
  }

  try {
    // Build the materialised state by replaying snapshot + cold segments
    // into an in-memory DB. This guarantees the snapshot encodes exactly
    // the same state as the source files would on a real rebuild.
    const tempDb = new Database(':memory:');
    try {
      createCompactionSchema(tempDb);
      replayFiles(tempDb, [snapshotPath, ...coldSegments].filter((f) => fs.existsSync(f)));

      const snapshotPayload = materialiseSnapshot(tempDb);
      const removedSideFiles = writeSnapshotAtomic(logRoot, snapshotPayload);

      // Delete cold segments only after the new snapshot is durable.
      for (const seg of coldSegments) {
        try { fs.unlinkSync(seg); } catch { /* race with peer */ }
      }
      pruneEmptyBuckets(logRoot);

      return {
        ran: true,
        compactedSegments: coldSegments.length,
        removedSideFiles,
      };
    } finally {
      tempDb.close();
    }
  } catch (err) {
    console.warn('[compaction] Snapshot write failed:', err);
    return { ran: false, reason: 'write-failed' };
  } finally {
    releaseLock(logRoot);
  }
}

/**
 * Peek the last event in a segment file and decide whether its ts is
 * before the cutoff. Falls back to mtime when the file is empty or
 * unparseable so we never accidentally compact in-flight writes.
 */
function isSegmentCold(segmentPath: string, cutoff: number): boolean {
  try {
    const lastTs = lastEventTs(segmentPath);
    if (lastTs !== null) return lastTs < cutoff;
    return fs.statSync(segmentPath).mtimeMs < cutoff;
  } catch {
    return false;
  }
}

function lastEventTs(segmentPath: string): number | null {
  // Files are <= 25 MB by log-store rotation, so a full read is fine.
  let content: string;
  try {
    content = fs.readFileSync(segmentPath, 'utf-8');
  } catch {
    return null;
  }
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event && typeof event.ts === 'string') {
        const ms = new Date(event.ts).getTime();
        if (!Number.isNaN(ms)) return ms;
      }
    } catch { /* try previous line */ }
  }
  return null;
}

/**
 * Create the subset of the production schema that replayLog needs.
 * Mirrors createSchema() in database.ts but stays local to keep the
 * compaction module decoupled from the long-lived DB module.
 */
function createCompactionSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY, description TEXT NOT NULL, body TEXT, raw_text TEXT,
      client TEXT, due_at TEXT, due_at_utc TEXT, recurrence TEXT,
      completed_at TEXT, folder TEXT, session_id TEXT, source_skill_id TEXT,
      attachments TEXT DEFAULT '[]', canvas_content TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'captured',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE canvas_agents (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, selected_text TEXT NOT NULL,
      session_id TEXT NOT NULL, pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, space_id TEXT,
      prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
      summary TEXT DEFAULT '', working_dir TEXT,
      source TEXT NOT NULL DEFAULT 'sdk', persona_handle TEXT,
      quoted_text TEXT,
      comment_thread_id TEXT,
      run_location TEXT NOT NULL DEFAULT 'local',
      cca_job_id TEXT,
      cca_repository TEXT,
      cca_effective_repository TEXT,
      cca_fallback_json TEXT,
      cca_result_json TEXT,
      yolo_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE space_events (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, event_type TEXT NOT NULL,
      due_at TEXT, due_at_utc TEXT, completed_at TEXT, recurrence_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE subagent_records (
      id TEXT PRIMARY KEY, parent_agent_id TEXT NOT NULL,
      tool_call_id TEXT, agent_name TEXT NOT NULL,
      display_name TEXT, description TEXT, agent_type TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL, completed_at INTEGER, duration_ms INTEGER,
      model TEXT, total_tokens INTEGER, total_tool_calls INTEGER,
      error TEXT, streaming_content TEXT DEFAULT '',
      streaming_content_path TEXT,
      turns_json TEXT DEFAULT '[]', turns_path TEXT,
      progress_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE subagent_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subagent_id TEXT NOT NULL, parent_agent_id TEXT NOT NULL,
      tool_call_id TEXT, tool_name TEXT NOT NULL,
      arguments_json TEXT, result TEXT, result_path TEXT,
      success INTEGER DEFAULT 1, error TEXT,
      started_at INTEGER, completed_at INTEGER, created_at TEXT NOT NULL
    );
  `);
}

function replayFiles(database: Database.Database, files: string[]): void {
  // Per-file replay inside a single transaction; bypasses replayLog's
  // listLogFiles walk so compaction stays in control of exactly which
  // files contribute to the temporary materialised state.
  const tx = database.transaction(() => {
    for (const file of files) {
      replayFile(file, database);
    }
  });
  tx();
}

function materialiseSnapshot(database: Database.Database): {
  spaces: any[];
  space_events: any[];
  canvas_agents: any[];
  agent_sessions: any[];
  subagent_records: any[];
  subagent_tool_calls: any[];
} {
  return {
    spaces: database.prepare('SELECT id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, source_skill_id, attachments, status, created_at, updated_at FROM spaces').all() as any[],
    space_events: database.prepare('SELECT id, space_id, event_type, due_at, due_at_utc, completed_at, recurrence_json, created_at FROM space_events').all() as any[],
    canvas_agents: database.prepare('SELECT id, space_id, selected_text, session_id, pid, status, created_at, updated_at FROM canvas_agents').all() as any[],
    agent_sessions: database.prepare('SELECT id, session_id, space_id, prompt, status, summary, working_dir, source, persona_handle, quoted_text, comment_thread_id, run_location, cca_job_id, cca_repository, cca_effective_repository, cca_fallback_json, cca_result_json, yolo_mode, created_at, updated_at FROM agent_sessions').all() as any[],
    subagent_records: database.prepare('SELECT id, parent_agent_id, tool_call_id, agent_name, display_name, description, agent_type, status, started_at, completed_at, duration_ms, model, total_tokens, total_tool_calls, error, streaming_content, streaming_content_path, turns_json, turns_path, progress_json, created_at, updated_at FROM subagent_records').all() as any[],
    subagent_tool_calls: database.prepare('SELECT subagent_id, parent_agent_id, tool_call_id, tool_name, arguments_json, result, result_path, success, error, started_at, completed_at, created_at FROM subagent_tool_calls').all() as any[],
  };
}

/**
 * Write the snapshot atomically (temp + rename) and GC the side files
 * for any subagent whose content has aged out of the keep window.
 * Returns the count of side files removed.
 */
function writeSnapshotAtomic(
  logRoot: string,
  payload: ReturnType<typeof materialiseSnapshot>,
): number {
  const snapshotPath = path.join(logRoot, SNAPSHOT_FILENAME);
  const tmpPath = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;

  // Strip side-file paths from compacted records: anything that's old
  // enough to be in the snapshot has aged out of the keep window, so
  // we drop the verbose content. The DB columns become a small inline
  // marker so the renderer can show "Full content unavailable" without
  // a disk read.
  const removedSideFiles: string[] = [];
  const compactedSubagents = payload.subagent_records.map((r) => {
    const dropped: string[] = [];
    if (r.streaming_content_path) dropped.push(r.streaming_content_path);
    if (r.turns_path) dropped.push(r.turns_path);
    removedSideFiles.push(...dropped);
    return {
      ...r,
      streaming_content: '',
      streaming_content_path: null,
      turns_json: '[]',
      turns_path: null,
    };
  });
  const compactedToolCalls = payload.subagent_tool_calls.map((tc) => {
    if (tc.result_path) removedSideFiles.push(tc.result_path);
    return { ...tc, result: null, result_path: null };
  });

  const event = {
    ts: new Date().toISOString(),
    op: 'snapshot',
    data: {
      spaces: payload.spaces,
      space_events: payload.space_events,
      canvas_agents: payload.canvas_agents,
      agent_sessions: payload.agent_sessions,
      subagent_records: compactedSubagents,
      subagent_tool_calls: compactedToolCalls,
    },
  };
  const line = JSON.stringify(event) + '\n';

  fs.writeFileSync(tmpPath, line, 'utf-8');
  // fsync via openSync('r+') for portability — fs.fsyncSync needs an fd.
  const fd = fs.openSync(tmpPath, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmpPath, snapshotPath);

  // Side-file GC happens after the snapshot is durable — if we crash
  // between rename and GC, the next run just retries the GC for the
  // same files (deleteContent is idempotent).
  const contentDir = getContentDir();
  if (contentDir) {
    for (const rel of removedSideFiles) {
      deleteContent(rel);
    }
  }
  return removedSideFiles.length;
}

function pruneEmptyBuckets(logRoot: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}$/.test(e.name)) continue;
    const dir = path.join(logRoot, e.name);
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* race with peer writer */ }
  }
}

// ── Advisory lock ───────────────────────────────────────────

function lockPath(logRoot: string): string {
  return path.join(logRoot, LOCK_FILENAME);
}

function acquireLock(logRoot: string): boolean {
  const target = lockPath(logRoot);
  try {
    fs.mkdirSync(logRoot, { recursive: true });
    // Exclusive create — fails if another process is already compacting.
    const fd = fs.openSync(target, 'wx');
    fs.writeSync(fd, `${process.pid} ${Date.now()}`);
    fs.closeSync(fd);
    return true;
  } catch (err: any) {
    if (err?.code !== 'EEXIST') {
      console.warn('[compaction] Lock acquisition failed:', err);
      return false;
    }
  }
  // Stale-lock reclaim: take over a lock that nobody has touched for a while.
  try {
    const stat = fs.statSync(target);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      fs.unlinkSync(target);
      return acquireLock(logRoot);
    }
  } catch { /* race with peer release */ }
  return false;
}

function releaseLock(logRoot: string): void {
  try { fs.unlinkSync(lockPath(logRoot)); } catch { /* may not exist */ }
}

/** Re-export the directory name so callers know what to gitignore. */
export { LOG_ROOT_DIRNAME };
