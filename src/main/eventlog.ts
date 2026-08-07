import * as fs from 'fs';
import Database from 'better-sqlite3';
import { resolveActiveSegment, listLogFiles } from './log-store';

export interface LogEvent {
  ts: string;
  op: string;
  data: Record<string, any>;
}

const ALLOWED_SPACE_FIELDS = new Set([
  'description', 'body', 'raw_text', 'client', 'due_at', 'due_at_utc',
  'recurrence', 'completed_at', 'folder', 'status', 'created_at', 'updated_at',
  'attachments', 'source_skill_id',
]);

/**
 * Append a single event to the active rotated segment under `logRoot`.
 *
 * The active segment is resolved per-call so callers don't need to know
 * about month buckets or 25 MB rotation — they just pass the workspace
 * log root and the LogStore picks the right file.
 */
export function appendEvent(logRoot: string, op: string, data: Record<string, any>): void {
  const event: LogEvent = {
    ts: new Date().toISOString(),
    op,
    data,
  };
  const line = JSON.stringify(event) + '\n';
  const target = resolveActiveSegment(logRoot);
  const fd = fs.openSync(target, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Replay every event under `logRoot` into `db`. Files are loaded in
 * chronological order (snapshot first, then segments by date) so the
 * resulting state matches what the live writers produced.
 *
 * Phase 3 will swap this for a streamed k-way merge with cached prepared
 * statements; for now we keep the existing semantics (single transaction,
 * one db.prepare per line) and just generalise across multiple files.
 */
export function replayLog(logRoot: string, db: Database.Database): void {
  const files = listLogFiles(logRoot);
  if (files.length === 0) return;

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
      for (const file of files) {
        replayOneFile(file, db);
      }
      purgeOrphanedRows(db);
    });

    replay();
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
export function replayFile(filePath: string, db: Database.Database): void {
  replayOneFile(filePath, db);
}

function replayOneFile(filePath: string, db: Database.Database): void {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Parsing and applying fail for very different reasons, and conflating
    // them was hiding real bugs: a SQL error from `applyEvent` was reported as
    // a "corrupt final line" and silently dropped, which quietly discarded a
    // whole snapshot — and with it every space the user had.
    let event: LogEvent;
    try {
      event = JSON.parse(line);
    } catch (err) {
      // A torn write can only ever be the last line (crash during append).
      const remaining = lines.slice(i + 1).some(l => l.trim());
      if (!remaining) {
        console.warn(`[eventlog] Ignoring corrupt final line ${i + 1} of ${filePath}`);
        continue;
      }
      throw new Error(`Corrupt event log at ${filePath}:${i + 1}: ${(err as Error).message}`);
    }

    try {
      applyEvent(db, event);
    } catch (err) {
      // The line was well-formed, so this is our bug, not a damaged file.
      // Never swallow it: replay is how the database is rebuilt.
      throw new Error(
        `Failed to apply event at ${filePath}:${i + 1} (op=${event.op}): ${(err as Error).message}`
      );
    }
  }
}

function applyEvent(db: Database.Database, event: LogEvent): void {
  // Backward compatibility: map old 'intent.*' ops to 'space.*'
  const op = event.op.replace(/^intent\./, 'space.');
  // Also normalize old field names in data
  const d = event.data;
  if (d.intent_id !== undefined && d.space_id === undefined) d.space_id = d.intent_id;

  switch (op) {
    case 'space.create': {
      const d = event.data;
      // Backfill body from raw_text/description for old events
      const body = d.body ?? d.raw_text ?? d.description ?? '';
      db.prepare(
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
          console.warn(`[eventlog] Skipping unknown field in update: ${key}`);
          continue;
        }
        sets.push(`${key} = ?`);
        values.push(val ?? null);
      }

      if (sets.length > 0) {
        values.push(d.id);
        db.prepare(`UPDATE spaces SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
      break;
    }

    case 'space.assign_folder': {
      const d = event.data;
      db.prepare('UPDATE spaces SET folder = ?, updated_at = ? WHERE id = ?')
        .run(d.folder, event.ts, d.id);
      break;
    }

    case 'space.delete': {
      db.prepare('DELETE FROM spaces WHERE id = ?').run(event.data.id);
      break;
    }

    case 'intent_event.log': {
      const d = event.data;
      db.prepare(
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
      db.prepare(
        `INSERT OR REPLACE INTO canvas_agents (id, space_id, selected_text, session_id, pid, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(d.id, d.space_id, d.selected_text, d.session_id, d.pid ?? null, d.status, d.created_at, d.updated_at);
      break;
    }

    case 'canvas_agent.updated': {
      const d = event.data;
      if (d.pid !== undefined && d.pid !== null) {
        db.prepare('UPDATE canvas_agents SET status = ?, pid = ?, updated_at = ? WHERE id = ?')
          .run(d.status, d.pid, d.updated_at, d.id);
      } else {
        db.prepare('UPDATE canvas_agents SET status = ?, updated_at = ? WHERE id = ?')
          .run(d.status, d.updated_at, d.id);
      }
      break;
    }

    case 'agent_session.created': {
      const d = event.data;
      // Normalize legacy source value: old 'cloud' meant CCA, now 'cca'
      const source = d.source === 'cloud' ? 'cca' : (d.source ?? 'sdk');
      const runLocation = d.run_location === 'cloud' ? 'cloud' : 'local';
      db.prepare(
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
      db.prepare('UPDATE agent_sessions SET cca_result_json = ?, updated_at = ? WHERE id = ?')
        .run(d.cca_result_json ?? null, d.updated_at ?? event.ts, d.id);
      break;
    }

    case 'agent_session.yolo': {
      const d = event.data;
      db.prepare('UPDATE agent_sessions SET yolo_mode = ?, updated_at = ? WHERE id = ?')
        .run(d.yolo_mode ? 1 : 0, d.updated_at, d.id);
      break;
    }

    case 'agent_session.updated': {
      const d = event.data;
      if (d.summary !== undefined && d.summary !== null) {
        db.prepare('UPDATE agent_sessions SET status = ?, summary = ?, updated_at = ? WHERE id = ?')
          .run(d.status ?? 'running', d.summary, d.updated_at, d.id);
      } else {
        db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?')
          .run(d.status ?? 'running', d.updated_at, d.id);
      }
      break;
    }

    case 'agent_session.deleted': {
      const d = event.data;
      db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(d.id);
      // Cascade chat events.  Older event logs may not have the table
      // when replayed standalone (tests) — guard with IF EXISTS-style
      // try/catch so a missing table is non-fatal.
      try {
        db.prepare('DELETE FROM agent_chat_events WHERE agent_id = ?').run(d.id);
      } catch { /* table missing — ignore */ }
      break;
    }

    case 'agent_chat.appended': {
      const d = event.data;
      try {
        db.prepare(
          `INSERT OR IGNORE INTO agent_chat_events (agent_id, seq, event_id, type, timestamp, payload)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          d.agent_id, d.seq, d.event_id ?? null, d.type,
          d.timestamp ?? event.ts, d.payload ?? '{}',
        );
      } catch (err) {
        // The agent_chat_events table is a recent addition.  When old
        // tests replay against a schema that doesn't define it, swallow
        // the error rather than aborting the entire replay transaction.
        console.warn(`[eventlog] agent_chat.appended replay skipped: ${(err as Error).message}`);
      }
      break;
    }

    case 'subagent.created': {
      const d = event.data;
      db.prepare(
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
      db.prepare(`UPDATE subagent_records SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      break;
    }

    case 'subagent_tool.created': {
      const d = event.data;
      db.prepare(
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
        db.prepare(`UPDATE subagent_tool_calls SET ${sets.join(', ')} WHERE subagent_id = ? AND tool_call_id = ?`).run(...values);
      }
      break;
    }

    case 'snapshot': {
      const d = event.data;
      // Support both old ('intents') and new ('spaces') snapshot keys
      const spaces = d.spaces ?? d.intents;
      if (spaces) {
        for (const s of spaces) {
          const body = s.body ?? s.raw_text ?? s.description ?? '';
          db.prepare(
            `INSERT OR REPLACE INTO spaces (id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, source_skill_id, attachments, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            s.id, s.description, body, s.raw_text ?? null, s.client ?? null,
            s.due_at ?? null, s.due_at_utc ?? null, s.recurrence ?? null,
            s.completed_at ?? null, s.folder ?? null, s.source_skill_id ?? null, s.attachments ?? '[]',
            s.status,
            s.created_at, s.updated_at,
          );
        }
      }
      // Support both old ('intent_events') and new ('space_events') keys
      const spaceEvents = d.space_events ?? d.intent_events;
      if (spaceEvents) {
        for (const evt of spaceEvents) {
          db.prepare(
            `INSERT OR REPLACE INTO space_events (id, space_id, event_type, due_at, due_at_utc, completed_at, recurrence_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            evt.id, evt.space_id ?? evt.intent_id, evt.event_type,
            evt.due_at ?? null, evt.due_at_utc ?? null,
            evt.completed_at ?? null, evt.recurrence_json ?? null,
            evt.created_at,
          );
        }
      }
      // Extended snapshot payload (Phase 4 compaction): bulk-restore
      // the remaining entity types so the snapshot encodes the full
      // materialised state.
      if (Array.isArray(d.canvas_agents)) {
        for (const a of d.canvas_agents) {
          db.prepare(
            `INSERT OR REPLACE INTO canvas_agents (id, space_id, selected_text, session_id, pid, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            a.id, a.space_id, a.selected_text, a.session_id,
            a.pid ?? null, a.status ?? 'completed', a.created_at, a.updated_at,
          );
        }
      }
      if (Array.isArray(d.agent_sessions)) {
        for (const a of d.agent_sessions) {
          const source = a.source === 'cloud' ? 'cca' : (a.source ?? 'sdk');
          db.prepare(
            `INSERT OR REPLACE INTO agent_sessions (id, session_id, space_id, prompt, status, summary, working_dir, source, persona_handle, quoted_text, comment_thread_id, run_location, cca_job_id, cca_repository, cca_effective_repository, cca_fallback_json, cca_result_json, yolo_mode, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            a.id, a.session_id, a.space_id ?? null, a.prompt,
            a.status ?? 'completed', a.summary ?? '', a.working_dir ?? null,
            source, a.persona_handle ?? null, a.quoted_text ?? null,
            a.comment_thread_id ?? null,
            a.run_location === 'cloud' ? 'cloud' : 'local',
            a.cca_job_id ?? null,
            a.cca_repository ?? null,
            a.cca_effective_repository ?? null,
            a.cca_fallback_json ?? null,
            a.cca_result_json ?? null,
            a.yolo_mode ? 1 : 0,
            a.created_at, a.updated_at,
          );
        }
      }
      if (Array.isArray(d.subagent_records)) {
        for (const r of d.subagent_records) {
          db.prepare(
            `INSERT OR REPLACE INTO subagent_records (id, parent_agent_id, tool_call_id, agent_name, display_name, description, agent_type, status, started_at, completed_at, duration_ms, model, total_tokens, total_tool_calls, error, streaming_content, streaming_content_path, turns_json, turns_path, progress_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            r.id, r.parent_agent_id, r.tool_call_id ?? null, r.agent_name,
            r.display_name ?? null, r.description ?? null, r.agent_type ?? null,
            r.status ?? 'completed', r.started_at, r.completed_at ?? null,
            r.duration_ms ?? null, r.model ?? null, r.total_tokens ?? null,
            r.total_tool_calls ?? null, r.error ?? null,
            r.streaming_content ?? '', r.streaming_content_path ?? null,
            r.turns_json ?? '[]', r.turns_path ?? null,
            r.progress_json ?? '{}', r.created_at, r.updated_at,
          );
        }
      }
      if (Array.isArray(d.subagent_tool_calls)) {
        for (const tc of d.subagent_tool_calls) {
          db.prepare(
            `INSERT INTO subagent_tool_calls (subagent_id, parent_agent_id, tool_call_id, tool_name, arguments_json, result, result_path, success, error, started_at, completed_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            tc.subagent_id, tc.parent_agent_id, tc.tool_call_id ?? null, tc.tool_name,
            tc.arguments_json ?? null, tc.result ?? null, tc.result_path ?? null,
            tc.success ?? 1, tc.error ?? null,
            tc.started_at ?? null, tc.completed_at ?? null, tc.created_at,
          );
        }
      }
      break;
    }

    default:
      console.warn(`[eventlog] Unknown event op: ${event.op}`);
  }
}
