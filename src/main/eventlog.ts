import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { resolveActiveSegment, listLogFiles, SNAPSHOT_FILENAME } from './log-store';
import { SNAPSHOT_COLUMNS, SNAPSHOT_OPERATIONS, type SnapshotTable } from './persistence-schema';
import { coveredOffset, parseManifest, readLines, readSnapshotManifest, resolveSnapshotChunk, syncDirectory, writeAll } from './persistence-snapshot';

export interface LogEvent {
  ts: string;
  op: string;
  data: Record<string, any>;
}

export interface AppendReceipt {
  path: string;
  before: { size: number; mtimeMs: number } | null;
  after: { size: number; mtimeMs: number };
  bytesWritten: number;
}

const statementCaches = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function prepare(db: Database.Database, sql: string): Database.Statement {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map();
    statementCaches.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    if (cache.size >= 256) cache.clear();
    cache.set(sql, statement);
  }
  return statement;
}

const ALLOWED_SPACE_FIELDS = new Set([
  'description', 'body', 'raw_text', 'client', 'due_at', 'due_at_utc',
  'recurrence', 'completed_at', 'folder', 'status', 'created_at', 'updated_at',
  'attachments', 'source_skill_id',
]);

const EVENT_FIELDS: Record<string, readonly string[]> = {
  'space.create': [...SNAPSHOT_COLUMNS.spaces.split(', '), 'session_id', 'canvas_content'],
  'space.update': ['id', 'fields'],
  'space.assign_folder': ['id', 'folder', 'updated_at'],
  'space.delete': ['id'],
  'intent_event.log': [...SNAPSHOT_COLUMNS.space_events.split(', '), 'intent_id'],
  'canvas_agent.created': SNAPSHOT_COLUMNS.canvas_agents.split(', '),
  'canvas_agent.updated': ['id', 'status', 'pid', 'pid_provided', 'updated_at'],
  'agent_session.created': SNAPSHOT_COLUMNS.agent_sessions.split(', '),
  'agent_session.updated': ['id', 'status', 'summary', 'session_id', 'updated_at'],
  'agent_session.cca_result': ['id', 'cca_result_json', 'updated_at'],
  'agent_session.yolo': ['id', 'yolo_mode', 'updated_at'],
  'agent_session.deleted': ['id'],
  'agent_chat.appended': [...SNAPSHOT_COLUMNS.agent_chat_events.split(', '), 'id'],
  'agent_chat.cleared': ['agent_id'],
  'subagent.created': [...SNAPSHOT_COLUMNS.subagent_records.split(', '), 'streaming_content_digest', 'turns_digest'],
  'subagent.updated': ['id', 'status', 'completed_at', 'duration_ms', 'model', 'total_tokens', 'total_tool_calls', 'error',
    'streaming_content', 'streaming_content_path', 'streaming_content_digest', 'turns_json', 'turns_path', 'turns_digest', 'progress_json', 'updated_at'],
  'subagent_tool.created': [...SNAPSHOT_COLUMNS.subagent_tool_calls.split(', '), 'id', 'result_digest'],
  'subagent_tool.updated': ['subagent_id', 'tool_call_id', 'success', 'error', 'completed_at', 'result', 'result_path', 'result_digest'],
};

/** Validation is shared by replay and retained-reference scanning before GC. */
export function validateDurableEvent(event: LogEvent): void {
  if (!event || typeof event.op !== 'string' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new Error('Invalid durable event');
  }
  const op = event.op.replace(/^intent\./, 'space.');
  if (op === 'snapshot') {
    for (const [key, rows] of Object.entries(event.data)) {
      const table = key === 'intents' ? 'spaces' : key === 'intent_events' ? 'space_events' : key;
      if (!Object.prototype.hasOwnProperty.call(SNAPSHOT_COLUMNS, table)) throw new Error(`Unsupported snapshot entity: ${key}`);
      if (!Array.isArray(rows)) throw new Error(`Invalid snapshot entity: ${key}`);
      const columns = SNAPSHOT_COLUMNS[table as keyof typeof SNAPSHOT_COLUMNS].split(', ');
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid snapshot row: ${key}`);
        for (const field of Object.keys(row)) {
          // Older snapshots may include local-only columns and SQLite row IDs.
          if (!columns.includes(field) && field !== 'id' &&
              !(table === 'spaces' && ['session_id', 'canvas_content'].includes(field)) &&
              !(table === 'space_events' && field === 'intent_id')) {
            throw new Error(`Unsupported snapshot field: ${key}.${field}`);
          }
        }
      }
    }
    return;
  }
  const allowed = EVENT_FIELDS[op];
  if (!allowed) throw new Error(`Unsupported durable event op: ${event.op}`);
  for (const field of Object.keys(event.data)) {
    if (!allowed.includes(field) && field !== 'intent_id') {
      throw new Error(`Unsupported durable event field: ${op}.${field}`);
    }
  }
  if (op === 'space.update') {
    if (!event.data.fields || typeof event.data.fields !== 'object' || Array.isArray(event.data.fields)) {
      throw new Error('Invalid space update fields');
    }
    for (const field of Object.keys(event.data.fields)) {
      if (!ALLOWED_SPACE_FIELDS.has(field)) throw new Error(`Unsupported space update field: ${field}`);
    }
  }
}

/**
 * Append a single event to the active rotated segment under `logRoot`.
 *
 * The active segment is resolved per-call so callers don't need to know
 * about month buckets or 25 MB rotation — they just pass the workspace
 * log root and the LogStore picks the right file.
 */
export function appendEvent(logRoot: string, op: string, data: Record<string, any>): AppendReceipt {
  const event: LogEvent = {
    ts: new Date().toISOString(),
    op,
    data,
  };
  const line = JSON.stringify(event) + '\n';
  const rootExisted = fs.existsSync(logRoot);
  const target = resolveActiveSegment(logRoot);
  const fileExisted = fs.existsSync(target);
  const before = fileExisted ? fs.statSync(target) : null;
  if (before?.size) {
    const input = fs.openSync(target, 'r');
    try {
      const last = Buffer.alloc(1);
      fs.readSync(input, last, 0, 1, before.size - 1);
      if (last[0] !== 10) throw new Error('Incomplete event log tail; recover before writing');
    } finally { fs.closeSync(input); }
  }
  const fd = fs.openSync(target, 'a');
  try {
    writeAll(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!fileExisted) {
    syncDirectory(path.dirname(target));
    syncDirectory(logRoot);
    if (!rootExisted) syncDirectory(path.dirname(logRoot));
  }
  const after = fs.statSync(target);
  return {
    path: target,
    before: before ? { size: before.size, mtimeMs: before.mtimeMs } : null,
    after: { size: after.size, mtimeMs: after.mtimeMs },
    bytesWritten: Buffer.byteLength(line),
  };
}

/** Repair append boundaries before opening storage, preserving damaged bytes. */
export function recoverLogTails(logRoot: string): void {
  for (const file of listLogFiles(logRoot)) {
    if (path.basename(file) === SNAPSHOT_FILENAME) continue;
    const fd = fs.openSync(file, 'r+');
    try {
      const size = fs.fstatSync(fd).size;
      if (!size) continue;
      const block = Buffer.allocUnsafe(64 * 1024);
      let end = size;
      let boundary = 0;
      while (end > 0) {
        const start = Math.max(0, end - block.length);
        const count = fs.readSync(fd, block, 0, end - start, start);
        const newline = block.subarray(0, count).lastIndexOf(10);
        if (newline >= 0) { boundary = start + newline + 1; break; }
        end = start;
      }
      if (boundary === size) continue;
      // Preserve the entire tail on disk before either fixing its delimiter or
      // truncating it. Stream the copy; a malformed legacy record may be huge.
      const quarantine = `${file}.torn-${crypto.randomUUID()}`;
      const output = fs.openSync(quarantine, 'wx', 0o600);
      try {
        for (let position = boundary; position < size;) {
          const count = fs.readSync(fd, block, 0, Math.min(block.length, size - position), position);
          if (!count) throw new Error('Event log changed during tail recovery');
          writeAll(output, block.subarray(0, count));
          position += count;
        }
        fs.fsyncSync(output);
      } finally { fs.closeSync(output); }
      syncDirectory(path.dirname(file));
      // Preserve valid unterminated JSON as a real event. Invalid JSON was
      // never acknowledged; retain its quarantined bytes for recovery.
      let valid = false;
      if (size - boundary > 25 * 1024 * 1024) {
        throw new Error('Oversized incomplete event retained for manual recovery; storage not opened');
      }
      if (size - boundary <= 25 * 1024 * 1024) {
        try { JSON.parse(fs.readFileSync(quarantine, 'utf8')); valid = true; }
        catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      }
      if (valid) fs.writeSync(fd, '\n', size, 'utf8');
      else fs.ftruncateSync(fd, boundary);
      fs.fsyncSync(fd);
      console.warn('[eventlog] Recovered incomplete append boundary', { bytes: size - boundary, retainedEvent: valid });
    } finally { fs.closeSync(fd); }
  }
}

/**
 * Replay every event under `logRoot` into `db`. Files are loaded in
 * chronological order (snapshot first, then segments by date) so the
 * resulting state matches what the live writers produced.
 *
 * Segments are streamed in their historical file order. Snapshot coverage
 * skips already-folded prefixes even if a crash left the source files behind.
 */
export function replayLog(logRoot: string, db: Database.Database, appliedOffsets?: ReadonlyMap<string, number>): { complete: boolean } {
  const files = listLogFiles(logRoot);
  if (files.length === 0) return { complete: true };

  // Foreign keys are enforced on the live database, but replay is a different
  // situation: the log is a chronological record, and a snapshot written by an
  // older schema can legitimately contain child rows whose parent has since
  // been deleted. Enforcing constraints mid-replay turns that recoverable junk
  // into a fatal startup failure that empties the user's entire space list.
  //
  // So rebuild with enforcement off, then drop the unreachable rows to restore
  // the invariant the constraints describe. The pragma is a no-op inside a
  // transaction, hence the toggle out here.
  const fkEnforced = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkEnforced) db.pragma('foreign_keys = OFF');

  try {
    const replay = db.transaction(() => {
      const manifest = readSnapshotManifest(logRoot);
      const covered = new Map(manifest.covered.map(entry => [entry.path, entry]));
      let complete = true;
      for (const file of files) {
        const relative = path.relative(logRoot, file).split(path.sep).join('/');
        const coveredStart = coveredOffset(file, covered.get(relative));
        const start = Math.max(coveredStart, appliedOffsets?.get(file) ?? 0);
        if (start === fs.statSync(file).size) continue;
        if (!replayOneFile(file, db, { start })) complete = false;
      }
      purgeOrphanedRows(db);
      return { complete };
    });

    return replay();
  } finally {
    if (fkEnforced) db.pragma('foreign_keys = ON');
  }
}

/**
 * Delete child rows whose parent no longer exists.
 *
 * These are unreachable either way — every read path joins through the parent
 * — so removing them loses nothing and lets foreign key enforcement be turned
 * back on for the live session.
 */
function purgeOrphanedRows(db: Database.Database): void {
  const relations: Array<{ table: string; column: string; parent: string }> = [
    { table: 'space_events', column: 'space_id', parent: 'spaces' },
    { table: 'canvas_agents', column: 'space_id', parent: 'spaces' },
    { table: 'subagent_tool_calls', column: 'subagent_id', parent: 'subagent_records' },
  ];

  for (const { table, column, parent } of relations) {
    // Replay also runs against partial schemas (tests, older databases), so
    // only touch pairs that are actually present.
    if (!tableExists(db, table) || !tableExists(db, parent)) continue;

    const result = db
      .prepare(
        `DELETE FROM ${table}
         WHERE ${column} IS NOT NULL
           AND ${column} NOT IN (SELECT id FROM ${parent})`
      )
      .run();
    if (result.changes > 0) {
      console.warn(
        `[eventlog] Dropped ${result.changes} orphaned ${table} row(s) with no matching ${parent}`
      );
    }
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) !== undefined
  );
}

/**
 * Replay the events of a single segment file. The caller owns the
 * transaction (so compaction can replay snapshot + cold segments
 * atomically without double-applying). Tolerates a corrupt final line
 * for crash recovery; mid-file corruption throws so the caller can
 * decide how to handle it.
 */
export function replayFile(
  filePath: string,
  db: Database.Database,
  options: { start?: number; strict?: boolean } = {},
): void {
  replayOneFile(filePath, db, options);
}

function replayOneFile(filePath: string, db: Database.Database, options: { start?: number; strict?: boolean; snapshotRowsOnly?: boolean } = {}): boolean {
  // Tolerating a torn last line only makes sense for the append-only segments,
  // where a crash mid-append is expected. The snapshot is written to a temp
  // file and renamed into place, so it is either wholly there or not there at
  // all — a malformed one is real corruption. It is also a single very long
  // line, so "skip the bad last line" would throw away every space the user
  // has and start them at empty, which is the worst possible response.
  const isAtomicFile = path.basename(filePath) === SNAPSHOT_FILENAME;
  let snapshotStarted = false;
  let snapshotEnded = false;
  let rows = 0;
  const hash = crypto.createHash('sha256');
  let tornLine: number | undefined;
  let incomplete = false;
  for (const input of readLines(filePath, options.start)) {
    if (!input.terminated) incomplete = true;
    const line = input.text.trim();
    if (!line) continue;
    if (tornLine !== undefined) throw new Error(`Corrupt event log at ${filePath}:${tornLine}`);

    // Parsing and applying fail for very different reasons, and conflating
    // them was hiding real bugs: a SQL error from `applyEvent` was reported as
    // a "corrupt final line" and silently dropped, which quietly discarded a
    // whole snapshot — and with it every space the user had.
    let event: LogEvent;
    try {
      event = JSON.parse(line);
    } catch (err) {
      if (!isAtomicFile && !options.strict) {
        tornLine = input.number;
        continue;
      }
      throw new Error(`Corrupt event log at ${filePath}:${input.number}: ${(err as Error).message}`);
    }

    try {
      if (!event || typeof event.op !== 'string' || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
        throw new Error('Invalid durable event');
      }
      if (options.strict && !input.terminated) throw new Error('Incomplete final line');
      if (options.snapshotRowsOnly && event.op !== 'snapshot') throw new Error('Unexpected snapshot chunk record');
      if (snapshotEnded) throw new Error('Data after snapshot end');
      if (event.op === 'snapshot.begin') {
        if (!isAtomicFile || snapshotStarted || rows > 0) throw new Error('Unexpected snapshot manifest');
        parseManifest(event.data);
        snapshotStarted = true;
        hash.update(input.text + '\n');
        continue;
      }
      if (event.op === 'snapshot.end') {
        if (!snapshotStarted || event.data.rows !== rows || event.data.sha256 !== hash.digest('hex')) {
          throw new Error('Incomplete or corrupt snapshot');
        }
        snapshotEnded = true;
        continue;
      }
      if (event.op === 'snapshot.chunk') {
        if (!isAtomicFile || !snapshotStarted) throw new Error('Unexpected snapshot chunk reference');
        const chunk = resolveSnapshotChunk(path.dirname(filePath), event.data);
        replayOneFile(chunk, db, { strict: true, snapshotRowsOnly: true });
        hash.update(input.text + '\n');
        rows++;
        continue;
      }
      if (snapshotStarted) {
        if (event.op !== 'snapshot') throw new Error('Unexpected snapshot row');
        hash.update(input.text + '\n');
      }
      applyEvent(db, event);
      rows++;
    } catch (err) {
      // The line was well-formed, so this is our bug, not a damaged file.
      // Never swallow it: replay is how the database is rebuilt.
      throw new Error(
        `Failed to apply event at ${filePath}:${input.number} (op=${event?.op}): ${(err as Error).message}`
      );
    }
  }
  if (snapshotStarted && !snapshotEnded) throw new Error(`Incomplete snapshot: ${filePath}`);
  if (tornLine !== undefined) console.warn(`[eventlog] Ignoring corrupt final line ${tornLine} of ${filePath}`);
  return tornLine === undefined && !incomplete;
}

function applyEvent(db: Database.Database, event: LogEvent): void {
  validateDurableEvent(event);
  // Backward compatibility: map old 'intent.*' ops to 'space.*'
  const op = event.op.replace(/^intent\./, 'space.');
  // Also normalize old field names in data
  const d = event.data;
  if (d.intent_id !== undefined && d.space_id === undefined) d.space_id = d.intent_id;

  const updateTable: Record<string, string> = {
    'space.update': 'spaces', 'space.assign_folder': 'spaces',
    'canvas_agent.updated': 'canvas_agents',
    'agent_session.updated': 'agent_sessions', 'agent_session.cca_result': 'agent_sessions', 'agent_session.yolo': 'agent_sessions',
    'subagent.updated': 'subagent_records',
  };
  const table = updateTable[op];
  // Legacy updateSpace always logged its timestamped fields, even when the
  // UPDATE matched no row. Still execute the SQL below to validate its bindings.
  const legacySpaceUpdate = op === 'space.update' && typeof d.id === 'string' && d.id.length > 0 &&
    typeof d.fields.updated_at === 'string' && Number.isFinite(Date.parse(d.fields.updated_at));
  if (table && !legacySpaceUpdate && !prepare(db, `SELECT 1 FROM ${table} WHERE id = ?`).get(d.id)) {
    // Older quick/comment sessions emitted this update without owning a canvas
    // row. Accept only that identifiable historical no-op, not arbitrary misses.
    if (op === 'canvas_agent.updated' && tableExists(db, 'agent_sessions') &&
        prepare(db, 'SELECT 1 FROM agent_sessions WHERE id = ?').get(d.id)) return;
    throw new Error(`Unapplied durable update: ${op} target does not exist`);
  }
  if (op === 'subagent_tool.updated' &&
      !prepare(db, 'SELECT 1 FROM subagent_tool_calls WHERE subagent_id = ? AND tool_call_id = ?').get(d.subagent_id, d.tool_call_id)) {
    throw new Error('Unapplied durable update: subagent tool target does not exist');
  }

  switch (op) {
    case 'space.create': {
      const d = event.data;
      // Backfill body from raw_text/description for old events
      const body = d.body ?? d.raw_text ?? d.description ?? '';
      prepare(db,
        `INSERT OR REPLACE INTO spaces (id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, source_skill_id, attachments, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d.id, d.description, body, d.raw_text ?? null, d.client ?? null,
        d.due_at ?? null, d.due_at_utc ?? null, d.recurrence ?? null,
        d.completed_at ?? null, d.folder ?? null, d.source_skill_id ?? null, d.attachments ?? '[]',
        d.status ?? 'captured',
        d.created_at, d.updated_at,
      );
      break;
    }

    case 'space.update': {
      const d = event.data;
      const fields = d.fields || {};
      const sets: string[] = [];
      const values: any[] = [];

      for (const [key, val] of Object.entries(fields)) {
        if (!ALLOWED_SPACE_FIELDS.has(key)) {
          throw new Error(`Unsupported space update field: ${key}`);
        }
        sets.push(`${key} = ?`);
        values.push(val ?? null);
      }

      if (sets.length > 0) {
        values.push(d.id);
        prepare(db, `UPDATE spaces SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
      break;
    }

    case 'space.assign_folder': {
      const d = event.data;
      prepare(db, 'UPDATE spaces SET folder = ?, updated_at = ? WHERE id = ?')
        .run(d.folder, d.updated_at ?? event.ts, d.id);
      break;
    }

    case 'space.delete': {
      prepare(db, 'DELETE FROM spaces WHERE id = ?').run(event.data.id);
      break;
    }

    case 'intent_event.log': {
      const d = event.data;
      prepare(db,
        `INSERT OR REPLACE INTO space_events (id, space_id, event_type, due_at, due_at_utc, completed_at, recurrence_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d.id, d.space_id, d.event_type,
        d.due_at ?? null, d.due_at_utc ?? null,
        d.completed_at ?? null, d.recurrence_json ?? null,
        d.created_at,
      );
      break;
    }

    case 'canvas_agent.created': {
      const d = event.data;
      prepare(db,
        `INSERT OR REPLACE INTO canvas_agents (id, space_id, selected_text, session_id, pid, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(d.id, d.space_id, d.selected_text, d.session_id, d.pid ?? null, d.status, d.created_at, d.updated_at);
      break;
    }

    case 'canvas_agent.updated': {
      const d = event.data;
      if (d.pid_provided === true || (d.pid !== undefined && d.pid !== null)) {
        prepare(db, 'UPDATE canvas_agents SET status = ?, pid = ?, updated_at = ? WHERE id = ?')
          .run(d.status, d.pid, d.updated_at, d.id);
      } else {
        prepare(db, 'UPDATE canvas_agents SET status = ?, updated_at = ? WHERE id = ?')
          .run(d.status, d.updated_at, d.id);
      }
      break;
    }

    case 'agent_session.created': {
      const d = event.data;
      // Normalize legacy source value: old 'cloud' meant CCA, now 'cca'
      const source = d.source === 'cloud' ? 'cca' : (d.source ?? 'sdk');
      const runLocation = d.run_location === 'cloud' ? 'cloud' : 'local';
      prepare(db,
        `INSERT OR REPLACE INTO agent_sessions (id, session_id, space_id, prompt, status, summary, working_dir, source, persona_handle, quoted_text, comment_thread_id, run_location, cca_job_id, cca_repository, cca_effective_repository, cca_fallback_json, cca_result_json, yolo_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d.id, d.session_id, d.space_id ?? null, d.prompt, d.status ?? 'running',
        d.summary ?? '', d.working_dir ?? null, source, d.persona_handle ?? null,
        d.quoted_text ?? null, d.comment_thread_id ?? null,
        runLocation, d.cca_job_id ?? null, d.cca_repository ?? null,
        d.cca_effective_repository ?? null, d.cca_fallback_json ?? null,
        d.cca_result_json ?? null, d.yolo_mode ? 1 : 0, d.created_at, d.updated_at,
      );
      break;
    }

    case 'agent_session.cca_result': {
      const d = event.data;
      prepare(db, 'UPDATE agent_sessions SET cca_result_json = ?, updated_at = ? WHERE id = ?')
        .run(d.cca_result_json ?? null, d.updated_at ?? event.ts, d.id);
      break;
    }

    case 'agent_session.yolo': {
      const d = event.data;
      prepare(db, 'UPDATE agent_sessions SET yolo_mode = ?, updated_at = ? WHERE id = ?')
        .run(d.yolo_mode ? 1 : 0, d.updated_at, d.id);
      break;
    }

    case 'agent_session.updated': {
      const d = event.data;
      const sets = ['updated_at = ?'];
      const values: Array<string | null> = [d.updated_at ?? event.ts];
      for (const key of ['status', 'summary', 'session_id']) {
        if (d[key] != null) {
          sets.push(`${key} = ?`);
          values.push(d[key]);
        }
      }
      prepare(db, `UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values, d.id);
      if (d.session_id != null) {
        prepare(db, 'UPDATE canvas_agents SET session_id = ?, updated_at = ? WHERE id = ?')
          .run(d.session_id, d.updated_at ?? event.ts, d.id);
      }
      break;
    }

    case 'agent_session.deleted': {
      const d = event.data;
      prepare(db, 'DELETE FROM agent_sessions WHERE id = ?').run(d.id);
      prepare(db, 'DELETE FROM agent_chat_events WHERE agent_id = ?').run(d.id);
      break;
    }

    case 'agent_chat.cleared': {
      prepare(db, 'DELETE FROM agent_chat_events WHERE agent_id = ?').run(d.agent_id);
      break;
    }

    case 'agent_chat.appended': {
      const d = event.data;
      const existing = prepare(db,
        'SELECT event_id, type, timestamp, payload FROM agent_chat_events WHERE agent_id = ? AND seq = ?',
      ).get(d.agent_id, d.seq) as { event_id: string | null; type: string; timestamp: string; payload: string } | undefined;
      const row = { event_id: d.event_id ?? null, type: d.type, timestamp: d.timestamp ?? event.ts, payload: d.payload ?? '{}' };
      if (existing) {
        if (existing.event_id !== row.event_id || existing.type !== row.type ||
            existing.timestamp !== row.timestamp || existing.payload !== row.payload) {
          throw new Error('Conflicting agent chat sequence');
        }
      } else {
        prepare(db,
          `INSERT INTO agent_chat_events (agent_id, seq, event_id, type, timestamp, payload)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(d.agent_id, d.seq, row.event_id, row.type, row.timestamp, row.payload);
      }
      break;
    }

    case 'subagent.created': {
      const d = event.data;
      prepare(db,
        `INSERT OR REPLACE INTO subagent_records (id, parent_agent_id, tool_call_id, agent_name, display_name, description, agent_type, status, started_at, completed_at, duration_ms, model, total_tokens, total_tool_calls, error, streaming_content, streaming_content_path, turns_json, turns_path, progress_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d.id, d.parent_agent_id, d.tool_call_id ?? null, d.agent_name,
        d.display_name ?? null, d.description ?? null, d.agent_type ?? null,
        d.status ?? 'running', d.started_at, d.completed_at ?? null,
        d.duration_ms ?? null, d.model ?? null, d.total_tokens ?? null,
        d.total_tool_calls ?? null, d.error ?? null,
        d.streaming_content ?? '', d.streaming_content_path ?? null,
        d.turns_json ?? '[]', d.turns_path ?? null,
        d.progress_json ?? '{}',
        d.created_at, d.updated_at,
      );
      break;
    }

    case 'subagent.updated': {
      const d = event.data;
      const sets: string[] = ['updated_at = ?'];
      const values: any[] = [d.updated_at ?? event.ts];
      for (const key of ['status', 'completed_at', 'duration_ms', 'model', 'total_tokens', 'total_tool_calls', 'error', 'progress_json']) {
        if (d[key] !== undefined) {
          sets.push(`${key} = ?`);
          values.push(d[key] ?? null);
        }
      }
      // streaming_content + streaming_content_path are paired: when either
      // is present in the event, write both columns to keep them in sync.
      if (d.streaming_content !== undefined || d.streaming_content_path !== undefined) {
        sets.push('streaming_content = ?', 'streaming_content_path = ?');
        values.push(d.streaming_content ?? '', d.streaming_content_path ?? null);
      }
      if (d.turns_json !== undefined || d.turns_path !== undefined) {
        sets.push('turns_json = ?', 'turns_path = ?');
        values.push(d.turns_json ?? '[]', d.turns_path ?? null);
      }
      values.push(d.id);
      prepare(db, `UPDATE subagent_records SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      break;
    }

    case 'subagent_tool.created': {
      const d = event.data;
      prepare(db,
        `INSERT INTO subagent_tool_calls (subagent_id, parent_agent_id, tool_call_id, tool_name, arguments_json, result, result_path, success, error, started_at, completed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d.subagent_id, d.parent_agent_id, d.tool_call_id ?? null, d.tool_name,
        d.arguments_json ?? null, d.result ?? null, d.result_path ?? null,
        d.success ?? 1, d.error ?? null,
        d.started_at ?? null, d.completed_at ?? null, d.created_at,
      );
      break;
    }

    case 'subagent_tool.updated': {
      const d = event.data;
      const sets: string[] = [];
      const values: any[] = [];
      for (const key of ['success', 'error', 'completed_at']) {
        if (d[key] !== undefined) {
          sets.push(`${key} = ?`);
          values.push(d[key] ?? null);
        }
      }
      if (d.result !== undefined || d.result_path !== undefined) {
        sets.push('result = ?', 'result_path = ?');
        values.push(d.result ?? null, d.result_path ?? null);
      }
      if (sets.length > 0) {
        values.push(d.subagent_id, d.tool_call_id);
        prepare(db, `UPDATE subagent_tool_calls SET ${sets.join(', ')} WHERE subagent_id = ? AND tool_call_id = ?`).run(...values);
      }
      break;
    }

    case 'snapshot': {
      for (const [key, rows] of Object.entries(event.data)) {
        const table = (key === 'intents' ? 'spaces' : key === 'intent_events' ? 'space_events' : key) as SnapshotTable;
        for (const row of rows) {
          const data = { ...row };
          if (['canvas_agents', 'agent_sessions', 'subagent_records'].includes(table)) {
            data.status ??= 'completed';
          }
          applyEvent(db, { ts: event.ts, op: SNAPSHOT_OPERATIONS[table], data });
        }
      }
      break;
    }

    default:
      throw new Error(`Unsupported durable event op: ${event.op}`);
  }
}
