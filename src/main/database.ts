import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Space, Attachment, CanvasAgent, AgentSession, AgentChatEvent, CreateSpaceInput, Skill, SkillFrontmatter } from '../shared/types';
import { appendEvent as appendLogEvent, replayLog, recoverLogTails, type AppendReceipt } from './eventlog';
import { createPersistenceSchema } from './persistence-schema';
import { createQueryIndexes, verifySearchCapabilities } from './query-index';
import { querySpacePage, querySpaceEventPage, queryAgentPage, queryActivityPage } from './paged-queries';
import type { SpacePageRequest, PageRequest, AgentPageRequest } from '../shared/paging';
import { queryChatHistoryPage } from './chat-history-page';
import { syncDirectory } from './persistence-snapshot';
import { hashFile } from './persistence-snapshot';
import { listLogFiles, SNAPSHOT_FILENAME } from './log-store';
import { readCanvas, slugify, resolveSpaceFolder } from './workspace';
import { deriveMarkdownTitle, ensureMarkdownH1Title } from '../shared/markdown-title';
import { initContentStore, closeContentStore, storeContent, type ContentRef } from './subagent-content-store';
import { indexSkills } from './storage-index';
import {
  canSkipReplay,
  computeFingerprint,
  fingerprintPathFor,
  readFingerprint,
  sameLogState,
  writeFingerprint,
  type Fingerprint,
} from './db-fingerprint';

let db: Database.Database;
/** Root of the rotated event-log tree (`<whim>/events/`). All appends and
 *  the startup replay flow through this root. */
let logRoot: string;
/** Path of the SQLite cache file; remembered so closeDatabase can refresh
 *  the fingerprint sidecar to reflect any events appended during this
 *  session. */
let dbFilePath: string;
/** Baseline replay inputs; acknowledged local appends are tracked separately. */
let appliedFingerprint: Fingerprint | undefined;
let expectedLogFiles = new Map<string, { size: number; mtimeMs: number }>();
let pendingAppend: AppendReceipt | undefined;
let fingerprintEligible = false;
const canvasMetadata = new Map<string, { size: number; mtimeMs: number }>();

function rememberAppliedInputs(fingerprint: Fingerprint): void {
  appliedFingerprint = fingerprint;
  expectedLogFiles = new Map(fingerprint.logFiles.map(file => [file.path, file]));
  pendingAppend = undefined;
  fingerprintEligible = true;
}

function appendEvent(root: string, op: string, data: Record<string, any>): void {
  if (pendingAppend) fingerprintEligible = false;
  // Until both the append and SQL application succeed, the cache is untrusted.
  const wasEligible = fingerprintEligible;
  fingerprintEligible = false;
  pendingAppend = appendLogEvent(root, op, data);
  const expected = expectedLogFiles.get(pendingAppend.path);
  const before = pendingAppend.before;
  fingerprintEligible = wasEligible &&
    (before ? expected?.size === before.size && expected.mtimeMs === before.mtimeMs : expected === undefined) &&
    pendingAppend.after.size === (before?.size ?? 0) + pendingAppend.bytesWritten;
}

/** Called only after the corresponding SQL mutation (and any cascades) succeeded. */
function acknowledgeAppliedEvent(): void {
  if (pendingAppend) expectedLogFiles.set(pendingAppend.path, pendingAppend.after);
  pendingAppend = undefined;
}

function requireUpdateTarget(table: 'spaces' | 'canvas_agents' | 'agent_sessions' | 'subagent_records', id: string): void {
  if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) {
    throw new Error(`Cannot durably update missing ${table} row`);
  }
}

export function isInitialized(): boolean {
  return db !== undefined;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = undefined as any;
    if (dbFilePath && logRoot) {
      try {
        const sidecar = fingerprintPathFor(dbFilePath);
        if (appliedFingerprint) {
          const current = computeFingerprint(logRoot, dbFilePath, appliedFingerprint);
          const matchesAcknowledged = fingerprintEligible && !pendingAppend &&
            current.logFiles.length === expectedLogFiles.size &&
            current.logFiles.every(file => {
              const expected = expectedLogFiles.get(file.path);
              return expected?.size === file.size && expected.mtimeMs === file.mtimeMs;
            });
          // A file added/changed by sync was not necessarily applied to SQLite.
          writeFingerprint(sidecar, {
            ...(matchesAcknowledged ? current : appliedFingerprint),
            db: current.db,
          });
        }
      } catch (err) {
        console.warn('[database] Failed to refresh fingerprint at close:', err);
      }
    }
    logRoot = '';
    dbFilePath = '';
  }
  appliedFingerprint = undefined;
  expectedLogFiles.clear();
  pendingAppend = undefined;
  fingerprintEligible = false;
  closeContentStore();
}

export function getDatabase(): Database.Database {
  return db;
}

/** Capture only state already acknowledged by SQLite, before a sync mutates files. */
export function checkpointAppliedState(): void {
  if (!appliedFingerprint || !fingerprintEligible || pendingAppend) {
    throw new Error('Storage requires recovery before synchronization');
  }
  const current = computeFingerprint(logRoot, dbFilePath);
  if (current.logFiles.length !== expectedLogFiles.size || current.logFiles.some(file => {
    const expected = expectedLogFiles.get(file.path);
    return expected?.size !== file.size || expected.mtimeMs !== file.mtimeMs;
  })) throw new Error('Unapplied external log changes; recover before synchronization');
  rememberAppliedInputs(current);
}

/** Only append-only suffixes after the last applied segment may replay incrementally. */
export function applyIncomingChanges(): void {
  const previous = appliedFingerprint;
  const current = computeFingerprint(logRoot, dbFilePath);
  const files = listLogFiles(logRoot);
  const previousFiles = previous?.logFiles.filter(file => !file.path.includes(`${path.sep}snapshots${path.sep}`)) ?? [];
  const offsets = new Map<string, number>();
  let incremental = !!previous && fingerprintEligible && !pendingAppend;
  // Local SQL acknowledgements may be newer than the last hashed checkpoint.
  // If there are no external changes, checkpoint directly instead of replaying
  // those events. Otherwise rebuild rather than double-applying a local suffix.
  const hasLocalAppends = previous && (expectedLogFiles.size !== previous.logFiles.length ||
    previous.logFiles.some(file => expectedLogFiles.get(file.path)?.size !== file.size));
  if (hasLocalAppends) {
    const matches = fingerprintEligible && !pendingAppend &&
      current.logFiles.length === expectedLogFiles.size && current.logFiles.every(file => {
        const expected = expectedLogFiles.get(file.path);
        return expected?.size === file.size && expected.mtimeMs === file.mtimeMs;
      }) && previous.logFiles.every(file => hashFile(file.path, file.size) === file.sha256);
    if (matches) { rememberAppliedInputs(current); return; }
    incremental = false;
  }
  for (let i = 0; i < previousFiles.length && incremental; i++) {
    const prior = previousFiles[i];
    const next = current.logFiles.find(file => file.path === prior.path);
    if (files[i] !== prior.path || !next || next.size < prior.size) { incremental = false; break; }
    const mayAppend = i === previousFiles.length - 1 && path.basename(prior.path) !== SNAPSHOT_FILENAME;
    if ((!mayAppend && next.size !== prior.size) || hashFile(prior.path, prior.size) !== prior.sha256) {
      incremental = false;
      break;
    }
    if (prior.size > 0) {
      const fd = fs.openSync(prior.path, 'r');
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, prior.size - 1);
        if (last[0] !== 10) incremental = false;
      } finally { fs.closeSync(fd); }
    }
    offsets.set(prior.path, prior.size);
  }
  // Immutable shard replacements require the fully validating rebuild path.
  if (previous?.logFiles.some(prior => prior.path.includes(`${path.sep}snapshots${path.sep}`) &&
      !current.logFiles.some(next => next.path === prior.path && next.sha256 === prior.sha256))) incremental = false;
  if (incremental) {
    const result = replayLog(logRoot, db, offsets);
    const after = computeFingerprint(logRoot, dbFilePath);
    if (!result.complete || !sameLogState(current, after)) {
      fingerprintEligible = false;
      throw new Error('Event log changed or was incomplete during synchronization');
    }
    rememberAppliedInputs(after);
    canvasMetadata.clear();
    return;
  }
  const location: [string, string] = [dbFilePath, logRoot];
  const workspaceRoot = path.dirname(path.dirname(dbFilePath));
  const sessions = db.prepare('SELECT id, session_id FROM spaces WHERE session_id IS NOT NULL')
    .all() as { id: string; session_id: string }[];
  const acknowledgedFiles = new Map(expectedLogFiles);
  try {
    initializeDatabase(...location, () => {
      mergeSessionIds(Object.fromEntries(sessions.map(row => [row.id, row.session_id])));
      syncCanvasContent(workspaceRoot);
      indexSkills(workspaceRoot);
    });
  } catch (error) {
    // The replacement is published only after all projections succeed. Keep
    // the last usable cache available, but force a validating rebuild on retry.
    db = new Database(location[0]);
    db.pragma('journal_mode = DELETE');
    db.pragma('recursive_triggers = ON');
    initContentStore(path.join(path.dirname(location[0]), 'subagent-content'));
    appliedFingerprint = previous;
    expectedLogFiles = acknowledgedFiles;
    fingerprintEligible = false;
    canvasMetadata.clear();
    throw error;
  }
}

/**
 * Initialize the SQLite cache at `dbPath`, replaying the rotated event
 * log under `eventLogRoot` to materialise it.
 *
 * Fast path: if a `db.fingerprint.json` sidecar shows the log files and
 * the DB file haven't changed since the last successful build (and the
 * schema version still matches), reuse the existing DB without
 * touching the log at all. This is the common case on a hot restart.
 *
 * Slow path (changed log, missing fingerprint, schema bump, tampered DB
 * file): build a replacement cache, replay every event, then atomically
 * publish it with a fresh fingerprint sidecar.
 */
export function initDatabase(dbPath: string, eventLogRoot: string): void {
  initializeDatabase(dbPath, eventLogRoot);
}

function initializeDatabase(dbPath: string, eventLogRoot: string, restoreProjections?: () => void): void {
  canvasMetadata.clear();
  if (db?.open) {
    db.close();
    db = undefined as any;
  }
  logRoot = eventLogRoot;
  dbFilePath = dbPath;
  appliedFingerprint = undefined;
  expectedLogFiles.clear();
  pendingAppend = undefined;
  fingerprintEligible = false;

  // Heavy sub-agent payloads (turn responses, large tool results) live in
  // <workspace>/.whim/subagent-content/ as side files instead of inline in
  // the event log. Initialise that store before replay so the applyEvent
  // handler can read paths that pre-existing events reference.
  initContentStore(path.join(path.dirname(dbPath), 'subagent-content'));

  recoverLogTails(eventLogRoot);
  const sidecarPath = fingerprintPathFor(dbPath);
  const previous = readFingerprint(sidecarPath);
  const current = computeFingerprint(eventLogRoot, dbPath, previous);

  const reuseCache = !restoreProjections && fs.existsSync(dbPath) && canSkipReplay(previous, current);
  if (process.env.WHIM_PERF === '1') console.info('[perf:storage-open]', {
    reuseCache, logFiles: current.logFiles.length,
  });
  if (reuseCache) {
    // Hot restart — the cache is still in sync with the log. Open the
    // existing DB and write a refreshed fingerprint: opening SQLite
    // touches the file (journal_mode pragma), so the recorded mtime
    // needs to track that or every subsequent startup would think the
    // DB had been tampered with.
    db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('recursive_triggers = ON');
    verifySearchCapabilities(db);
    const refreshed = computeFingerprint(eventLogRoot, dbPath, previous);
    if (sameLogState(current, refreshed)) {
      rememberAppliedInputs(refreshed);
      writeFingerprint(sidecarPath, refreshed);
    } else {
      db.close();
      db = undefined as any;
      throw new Error('Event log changed while opening the cache; retry initialization');
    }
    return;
  }

  // Build beside the existing cache. Unsupported/corrupt logs must not destroy
  // the last usable database, nor publish a success-shaped fingerprint.
  const temporaryPath = `${dbPath}.rebuild-${process.pid}-${uuidv4()}`;
  try {
    db = new Database(temporaryPath);
    db.pragma('journal_mode = DELETE');
    createSchema(db);
    const replayResult = replayLog(eventLogRoot, db);
    createQueryIndexes(db);
    if (restoreProjections) {
      if (!replayResult.complete) throw new Error('Incomplete event log during synchronization');
      restoreProjections();
    }
    db.close();
    db = undefined as any;
    const afterReplay = computeFingerprint(eventLogRoot, temporaryPath, current);
    if (!sameLogState(current, afterReplay)) {
      throw new Error('Event log changed during replay; retry initialization');
    }
    fs.renameSync(temporaryPath, dbPath);
    // Journals belong to the replaced derived cache, never to the new DB.
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const file = dbPath + suffix;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    syncDirectory(path.dirname(dbPath));
    db = new Database(dbPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('recursive_triggers = ON');
    verifySearchCapabilities(db);
    const stat = fs.statSync(dbPath);
    if (replayResult?.complete !== false) {
      const fingerprint = {
        ...afterReplay,
        db: { path: dbPath, size: stat.size, mtimeMs: stat.mtimeMs },
      };
      rememberAppliedInputs(fingerprint);
      writeFingerprint(sidecarPath, fingerprint);
    } else if (fs.existsSync(sidecarPath)) {
      fs.unlinkSync(sidecarPath);
    }
  } catch (err) {
    if (db?.open) db.close();
    db = undefined as any;
    appliedFingerprint = undefined;
    closeContentStore();
    throw err;
  } finally {
    for (const file of [temporaryPath, `${temporaryPath}-journal`]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

/** Log-backed schema plus the separately file-backed skills cache. */
function createSchema(database: Database.Database): void {
  createPersistenceSchema(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      emoji TEXT NOT NULL DEFAULT '🧩',
      folder_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      schedule TEXT,
      schedule_time TEXT,
      schedule_day INTEGER,
      next_run_at TEXT,
      last_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

/** Inject per-machine session IDs from local config into the DB after replay. */
export function mergeSessionIds(sessions: Record<string, string>): void {
  const stmt = db.prepare('UPDATE spaces SET session_id = ? WHERE id = ?');
  for (const [spaceId, sessionId] of Object.entries(sessions)) {
    stmt.run(sessionId, spaceId);
  }
}

function parseAttachments(raw: string | null | undefined): Attachment[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

export function createSpace(input: CreateSpaceInput, sourceSkillId?: string): Space {
  const now = new Date().toISOString();
  const id = uuidv4();
  const normalizedCanvas = ensureMarkdownH1Title(input.body);
  const title = deriveMarkdownTitle(normalizedCanvas.content);
  // Folder slug is deterministic from id + description, so we can record it in
  // the create event up front and defer the actual on-disk folder creation.
  const folder = slugify(title, id);

  const space: Space = {
    id,
    description: title,
    body: normalizedCanvas.content,
    raw_text: input.body,
    client: null,
    due_at: null,
    due_at_utc: null,
    recurrence: null,
    completed_at: null,
    folder,
    session_id: null,
    source_skill_id: sourceSkillId ?? null,
    attachments: [],
    status: 'captured',
    created_at: now,
    updated_at: now,
  };

  // Log first — the event log is authoritative
  appendEvent(logRoot, 'space.create', {
    id: space.id,
    description: space.description,
    body: space.body,
    raw_text: space.raw_text,
    client: space.client,
    due_at: space.due_at,
    due_at_utc: space.due_at_utc,
    recurrence: space.recurrence,
    completed_at: space.completed_at,
    folder: space.folder,
    source_skill_id: space.source_skill_id,
    attachments: JSON.stringify(space.attachments),
    status: space.status,
    created_at: space.created_at,
    updated_at: space.updated_at,
  });

  db.prepare(
    `INSERT INTO spaces (id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, session_id, source_skill_id, attachments, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(space.id, space.description, space.body, space.raw_text, space.client, space.due_at, space.due_at_utc, space.recurrence, space.completed_at, space.folder, space.session_id, space.source_skill_id, JSON.stringify(space.attachments), space.status, space.created_at, space.updated_at);
  acknowledgeAppliedEvent();

  return space;
}

export function getSpace(id: string): Space | null {
  const row = db.prepare(
    `SELECT id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, session_id, source_skill_id, attachments, status, created_at, updated_at
     FROM spaces WHERE id = ?`
  ).get(id) as any | undefined;
  if (!row) return null;
  return { ...row, attachments: parseAttachments(row.attachments) };
}

export function listSpaces(): Space[] {
  const rows = db.prepare(
    `SELECT id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, session_id, source_skill_id, attachments, status, created_at, updated_at
     FROM spaces
     ORDER BY
       CASE WHEN status = 'done' THEN 1 ELSE 0 END ASC,
       CASE WHEN status = 'in_progress' THEN 0 ELSE 1 END ASC,
       CASE WHEN due_at_utc IS NOT NULL THEN 0 ELSE 1 END ASC,
       due_at_utc ASC,
       updated_at DESC`
  ).all() as any[];
  return rows.map(r => ({ ...r, attachments: parseAttachments(r.attachments) }));
}

export function listSpaceSummaries(request: SpacePageRequest = {}) {
  return querySpacePage(db, request);
}

export function listSpaceEventsPage(request: PageRequest = {}) {
  return querySpaceEventPage(db, request);
}

export function listAgentSummaries(request: AgentPageRequest = {}) {
  return queryAgentPage(db, request);
}

export function listAgentHistoryPage(agentId: string, request: PageRequest = {}) {
  return queryChatHistoryPage(db, agentId, request);
}

export function listActivityPage(request: import('../shared/paging').ActivityPageRequest = {}) {
  return queryActivityPage(db, request);
}

export function getSpaceSummary(id: string) {
  return db.prepare(`SELECT id, description, client, due_at, due_at_utc, recurrence, completed_at, folder,
    session_id, source_skill_id, status, created_at, updated_at FROM spaces WHERE id=?`).get(id) as import('../shared/paging').SpaceSummary | undefined ?? null;
}

export function invalidateCanvasMetadata(file?: string): void {
  if (file) canvasMetadata.delete(file);
  else canvasMetadata.clear();
}

export function updateSpace(id: string, updates: Partial<Pick<Space, 'description' | 'body' | 'client' | 'due_at' | 'due_at_utc' | 'recurrence' | 'completed_at' | 'status' | 'attachments'>>): Space | null {
  if (!db.prepare('SELECT 1 FROM spaces WHERE id = ?').get(id)) return null;
  const now = new Date().toISOString();
  const fields: Record<string, string | null> = { updated_at: now };

  if (updates.description !== undefined) fields.description = updates.description;
  if (updates.body !== undefined) fields.body = updates.body;
  if (updates.client !== undefined) fields.client = updates.client;
  if (updates.due_at !== undefined) fields.due_at = updates.due_at;
  if (updates.due_at_utc !== undefined) fields.due_at_utc = updates.due_at_utc;
  if (updates.recurrence !== undefined) fields.recurrence = updates.recurrence;
  if (updates.completed_at !== undefined) fields.completed_at = updates.completed_at;
  if (updates.status !== undefined) fields.status = updates.status;
  if (updates.attachments !== undefined) fields.attachments = JSON.stringify(updates.attachments);

  // Log first
  appendEvent(logRoot, 'space.update', { id, fields });

  const sets = Object.keys(fields).map(k => `${k} = ?`);
  const values = [...Object.values(fields), id];
  db.prepare(`UPDATE spaces SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  acknowledgeAppliedEvent();

  return getSpace(id);
}

/** Compare-and-swap update: only applies if updated_at matches expectedVersion. */
export function updateSpaceCAS(id: string, expectedVersion: string, updates: Partial<Pick<Space, 'description' | 'body' | 'client' | 'due_at' | 'due_at_utc' | 'recurrence' | 'completed_at' | 'status' | 'attachments'>>): Space | null {
  const current = getSpace(id);
  if (!current || current.updated_at !== expectedVersion) return null;
  return updateSpace(id, updates);
}

/** Assign a workspace folder to an space. Logged as a dedicated event. */
export function assignSpaceFolder(spaceId: string, folder: string): void {
  requireUpdateTarget('spaces', spaceId);
  const now = new Date().toISOString();
  appendEvent(logRoot, 'space.assign_folder', { id: spaceId, folder, updated_at: now });
  db.prepare('UPDATE spaces SET folder = ?, updated_at = ? WHERE id = ?')
    .run(folder, now, spaceId);
  acknowledgeAppliedEvent();
}

export function logSpaceEvent(spaceId: string, eventType: string, data: { due_at?: string | null; due_at_utc?: string | null; completed_at?: string | null; recurrence_json?: string | null } = {}): void {
  const now = new Date().toISOString();
  const eventId = uuidv4();

  appendEvent(logRoot, 'intent_event.log', {
    id: eventId,
    space_id: spaceId,
    event_type: eventType,
    due_at: data.due_at ?? null,
    due_at_utc: data.due_at_utc ?? null,
    completed_at: data.completed_at ?? null,
    recurrence_json: data.recurrence_json ?? null,
    created_at: now,
  });

  db.prepare(
    `INSERT INTO space_events (id, space_id, event_type, due_at, due_at_utc, completed_at, recurrence_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(eventId, spaceId, eventType, data.due_at ?? null, data.due_at_utc ?? null, data.completed_at ?? null, data.recurrence_json ?? null, now);
  acknowledgeAppliedEvent();
}

export interface SpaceEvent {
  id: string;
  space_id: string;
  event_type: string;
  due_at: string | null;
  due_at_utc: string | null;
  completed_at: string | null;
  recurrence_json: string | null;
  created_at: string;
  space_description: string | null;
  space_client: string | null;
  session_id: string | null;
}

export function listSpaceEvents(limit = 100): SpaceEvent[] {
  return db.prepare(
    `SELECT e.id, e.space_id, e.event_type, e.due_at, e.due_at_utc, e.completed_at, e.recurrence_json, e.created_at,
            i.description AS space_description, i.client AS space_client, i.session_id
     FROM space_events e
     LEFT JOIN spaces i ON e.space_id = i.id
     ORDER BY e.created_at DESC
     LIMIT ?`
  ).all(limit) as SpaceEvent[];
}

/** Set session_id on an space — local only, not logged (per-machine). */
export function setSpaceSessionId(spaceId: string, sessionId: string): void {
  db.prepare('UPDATE spaces SET session_id = ? WHERE id = ?')
    .run(sessionId, spaceId);
}

export function deleteSpace(id: string): boolean {
  appendEvent(logRoot, 'space.delete', { id });
  const result = db.prepare('DELETE FROM spaces WHERE id = ?').run(id);
  acknowledgeAppliedEvent();
  return result.changes > 0;
}

/** Read all canvas files from disk and populate the canvas_content column. */
export function syncCanvasContent(workspaceRoot: string): void {
  let cursor: string | undefined;
  do { cursor = syncCanvasBatch(workspaceRoot, cursor).cursor; } while (cursor);
}

export function syncCanvasBatch(workspaceRoot: string, cursor = ''): { cursor?: string } {
  const rows = db.prepare('SELECT id, folder FROM spaces WHERE folder IS NOT NULL AND id > ? ORDER BY id LIMIT 16')
    .all(cursor) as { id: string; folder: string }[];
  const stmt = db.prepare('UPDATE spaces SET canvas_content = ? WHERE id = ?');
  for (const row of rows) {
    const file = path.join(resolveSpaceFolder(workspaceRoot, row.folder), 'canvas.md');
    try {
      const stat = fs.statSync(file);
      const previous = canvasMetadata.get(file);
      if (previous?.size === stat.size && previous.mtimeMs === stat.mtimeMs) continue;
      const content = readCanvas(workspaceRoot, row.folder);
      stmt.run(content, row.id);
      if (content.trim()) syncDerivedSpaceTitle(row.id, content);
      canvasMetadata.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      canvasMetadata.delete(file);
      stmt.run('', row.id);
    }
  }
  return rows.length === 16 ? { cursor: rows[rows.length - 1].id } : {};
}

function syncDerivedSpaceTitle(spaceId: string, content: string): { title: string; changed: boolean } {
  const title = deriveMarkdownTitle(content);
  const row = db.prepare('SELECT description FROM spaces WHERE id = ?').get(spaceId) as { description: string } | undefined;
  if (!row || row.description === title) return { title, changed: false };
  db.prepare('UPDATE spaces SET description = ? WHERE id = ?').run(title, spaceId);
  return { title, changed: true };
}

/** Update the cached canvas content for a single space. */
export function updateCanvasContent(spaceId: string, content: string): { title: string; titleChanged: boolean } {
  db.prepare('UPDATE spaces SET canvas_content = ? WHERE id = ?').run(content, spaceId);
  const result = syncDerivedSpaceTitle(spaceId, content);
  return { title: result.title, titleChanged: result.changed };
}

/**
 * Most recent space produced by a skill, whatever its status.
 *
 * Completed spaces are included on purpose: a recurring skill should refresh
 * the space the user already knows rather than leaving a trail of one space per
 * occurrence, so a completed one is reopened instead of replaced.
 */
export function getLatestSpaceForSkill(skillId: string): Space | null {
  const row = db.prepare(
    `SELECT id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, session_id, source_skill_id, attachments, status, created_at, updated_at
     FROM spaces WHERE source_skill_id = ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(skillId) as any | undefined;
  if (!row) return null;
  return { ...row, attachments: parseAttachments(row.attachments) };
}

/** Whether a space has an agent session that is still working. */
export function hasActiveAgentForSpace(spaceId: string): boolean {
  const row = db.prepare(
    `SELECT 1 FROM agent_sessions
     WHERE space_id = ? AND status IN ('running', 'waiting-approval')
     LIMIT 1`
  ).get(spaceId);
  return !!row;
}

/** Search spaces by description, body, or canvas content. */
export function searchSpaces(query: string): Space[] {
  const like = `%${query}%`;
  const rows = db.prepare(
    `SELECT id, description, body, raw_text, client, due_at, due_at_utc, recurrence, completed_at, folder, session_id, source_skill_id, attachments, status, created_at, updated_at
     FROM spaces
     WHERE description LIKE ? OR body LIKE ? OR canvas_content LIKE ?
     ORDER BY updated_at DESC`
  ).all(like, like, like) as any[];
  return rows.map(r => ({ ...r, attachments: parseAttachments(r.attachments) }));
}

// ── Canvas Agents ─────────────────────────────────────────

export function createCanvasAgent(agent: CanvasAgent): void {
  appendEvent(logRoot, 'canvas_agent.created', {
    id: agent.id,
    space_id: agent.space_id,
    selected_text: agent.selected_text,
    session_id: agent.session_id,
    pid: agent.pid,
    status: agent.status,
    created_at: agent.created_at,
    updated_at: agent.updated_at,
  });

  db.prepare(
    `INSERT INTO canvas_agents (id, space_id, selected_text, session_id, pid, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(agent.id, agent.space_id, agent.selected_text, agent.session_id, agent.pid, agent.status, agent.created_at, agent.updated_at);
  acknowledgeAppliedEvent();
}

export function updateCanvasAgentStatus(id: string, status: 'running' | 'waiting-approval' | 'completed' | 'failed', pid?: number | null): void {
  // Quick/comment agents own a session but no canvas-agent projection.
  if (!db.prepare('SELECT 1 FROM canvas_agents WHERE id = ?').get(id) &&
      db.prepare('SELECT 1 FROM agent_sessions WHERE id = ?').get(id)) return;
  requireUpdateTarget('canvas_agents', id);
  const now = new Date().toISOString();
  appendEvent(logRoot, 'canvas_agent.updated', { id, status, pid: pid ?? null, pid_provided: pid !== undefined, updated_at: now });
  const updates: any[] = [status, now];
  let sql = 'UPDATE canvas_agents SET status = ?, updated_at = ?';
  if (pid !== undefined) {
    sql += ', pid = ?';
    updates.push(pid);
  }
  sql += ' WHERE id = ?';
  updates.push(id);
  db.prepare(sql).run(...updates);
  acknowledgeAppliedEvent();
}

export function listCanvasAgents(spaceId: string): CanvasAgent[] {
  return db.prepare(
    `SELECT id, space_id, selected_text, session_id, pid, status, created_at, updated_at
     FROM canvas_agents WHERE space_id = ? ORDER BY created_at DESC`
  ).all(spaceId) as CanvasAgent[];
}

export function listAllRunningAgents(): CanvasAgent[] {
  return db.prepare(
    `SELECT id, space_id, selected_text, session_id, pid, status, created_at, updated_at
     FROM canvas_agents WHERE status = 'running'`
  ).all() as CanvasAgent[];
}

// ── Agent Sessions (central registry) ─────────────────────

export function createAgentSession(session: AgentSession): void {
  appendEvent(logRoot, 'agent_session.created', {
    id: session.id,
    session_id: session.session_id,
    space_id: session.space_id,
    prompt: session.prompt,
    status: session.status,
    summary: session.summary,
    working_dir: session.working_dir,
    source: session.source,
    persona_handle: session.persona_handle,
    quoted_text: session.quoted_text,
    comment_thread_id: session.comment_thread_id ?? null,
    run_location: session.run_location,
    cca_job_id: session.cca_job_id ?? null,
    cca_repository: session.cca_repository ?? null,
    cca_effective_repository: session.cca_effective_repository ?? null,
    cca_fallback_json: session.cca_fallback_json ?? null,
    cca_result_json: session.cca_result_json ?? null,
    yolo_mode: session.yolo_mode ?? false,
    created_at: session.created_at,
    updated_at: session.updated_at,
  });

  db.prepare(
    `INSERT INTO agent_sessions (id, session_id, space_id, prompt, status, summary, working_dir, source, persona_handle, quoted_text, comment_thread_id, run_location, cca_job_id, cca_repository, cca_effective_repository, cca_fallback_json, cca_result_json, yolo_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.id, session.session_id, session.space_id, session.prompt,
    session.status, session.summary, session.working_dir, session.source,
    session.persona_handle, session.quoted_text, session.comment_thread_id ?? null,
    session.run_location ?? 'local',
    session.cca_job_id ?? null,
    session.cca_repository ?? null,
    session.cca_effective_repository ?? null,
    session.cca_fallback_json ?? null,
    session.cca_result_json ?? null,
    session.yolo_mode ? 1 : 0,
    session.created_at, session.updated_at,
  );
  acknowledgeAppliedEvent();
}

export function updateAgentSessionStatus(id: string, status: string, summary?: string): void {
  requireUpdateTarget('agent_sessions', id);
  const now = new Date().toISOString();
  appendEvent(logRoot, 'agent_session.updated', { id, status, summary: summary ?? null, updated_at: now });

  if (summary !== undefined) {
    db.prepare('UPDATE agent_sessions SET status = ?, summary = ?, updated_at = ? WHERE id = ?')
      .run(status, summary, now, id);
  } else {
    db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, id);
  }
  acknowledgeAppliedEvent();
}

export function updateAgentSessionCcaResult(id: string, result: string): void {
  requireUpdateTarget('agent_sessions', id);
  const now = new Date().toISOString();
  appendEvent(logRoot, 'agent_session.cca_result', { id, cca_result_json: result, updated_at: now });
  db.prepare('UPDATE agent_sessions SET cca_result_json = ?, updated_at = ? WHERE id = ?')
    .run(result, now, id);
  acknowledgeAppliedEvent();
}

/** Persist the per-session yolo (auto-approve) flag so it survives app restart. */
export function updateAgentSessionYolo(id: string, enabled: boolean): void {
  requireUpdateTarget('agent_sessions', id);
  const now = new Date().toISOString();
  appendEvent(logRoot, 'agent_session.yolo', { id, yolo_mode: enabled, updated_at: now });
  db.prepare('UPDATE agent_sessions SET yolo_mode = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, now, id);
  acknowledgeAppliedEvent();
}

export function getAgentSession(id: string): AgentSession | null {
  const row = db.prepare(
    `SELECT id, session_id, space_id, prompt, status, summary, working_dir, source, persona_handle, quoted_text, comment_thread_id, run_location, cca_job_id, cca_repository, cca_effective_repository, cca_fallback_json, cca_result_json, yolo_mode, created_at, updated_at
     FROM agent_sessions WHERE id = ?`
  ).get(id) as (Omit<AgentSession, 'yolo_mode'> & { yolo_mode: number }) | undefined;
  if (!row) return null;
  return { ...row, yolo_mode: !!row.yolo_mode };
}

export function listAgentSessions(spaceId?: string): AgentSession[] {
  const rows = db.prepare(
    `SELECT id, session_id, space_id, prompt, status, summary, working_dir, source, persona_handle, quoted_text, comment_thread_id, run_location, cca_job_id, cca_repository, cca_effective_repository, cca_fallback_json, cca_result_json, yolo_mode, created_at, updated_at
     FROM agent_sessions ${spaceId === undefined ? '' : 'WHERE space_id = ?'} ORDER BY created_at DESC`
  ).all(...(spaceId === undefined ? [] : [spaceId])) as Array<Omit<AgentSession, 'yolo_mode'> & { yolo_mode: number }>;
  return rows.map((r) => ({ ...r, yolo_mode: !!r.yolo_mode }));
}

/** Update the session_id for an agent across both tables (e.g. after session recreation). */
export function updateAgentSessionId(id: string, newSessionId: string): void {
  requireUpdateTarget('agent_sessions', id);
  const now = new Date().toISOString();
  appendEvent(logRoot, 'agent_session.updated', { id, session_id: newSessionId, updated_at: now });
  db.prepare('UPDATE agent_sessions SET session_id = ?, updated_at = ? WHERE id = ?')
    .run(newSessionId, now, id);
  db.prepare('UPDATE canvas_agents SET session_id = ?, updated_at = ? WHERE id = ?')
    .run(newSessionId, now, id);
  acknowledgeAppliedEvent();
}

export function deleteAgentSession(id: string): void {
  appendEvent(logRoot, 'agent_session.deleted', { id });
  db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id);
  // Cascade chat events when the session goes away.
  db.prepare('DELETE FROM agent_chat_events WHERE agent_id = ?').run(id);
  acknowledgeAppliedEvent();
}

// ── Agent Chat Events ────────────────────────────────────
// Captured from the SDK session's catch-all event stream so we can
// reconstruct a transcript independent of the SDK runtime.  Used by
// `replayChatIntoFreshSession` when the original session can't be
// resumed.

/**
 * Append a chat event for an agent.  Returns the newly-assigned `seq`.
 *
 * Idempotent on `(agent_id, event_id)`: if `event_id` is provided and a
 * row with the same agent + event_id already exists, the existing row's
 * seq is returned without inserting a duplicate.  This protects against
 * double-capture when the SDK replays events on resume.
 */
export function appendAgentChatEvent(
  agentId: string,
  event: { event_id: string | null; type: string; timestamp: string; payload: string },
): number {
  // Idempotency: same SDK event id ⇒ no-op insert, return existing seq.
  if (event.event_id) {
    const existing = db.prepare(
      'SELECT seq FROM agent_chat_events WHERE agent_id = ? AND event_id = ?'
    ).get(agentId, event.event_id) as { seq: number } | undefined;
    if (existing) return existing.seq;
  }

  const row = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM agent_chat_events WHERE agent_id = ?'
  ).get(agentId) as { max_seq: number };
  const seq = row.max_seq + 1;

  appendEvent(logRoot, 'agent_chat.appended', {
    agent_id: agentId,
    seq,
    event_id: event.event_id,
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload,
  });

  db.prepare(
    `INSERT INTO agent_chat_events (agent_id, seq, event_id, type, timestamp, payload)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(agentId, seq, event.event_id, event.type, event.timestamp, event.payload);
  acknowledgeAppliedEvent();

  return seq;
}

/** Return all persisted chat events for an agent, ordered oldest-first. */
export function listAgentChatEvents(agentId: string): AgentChatEvent[] {
  return db.prepare(
    `SELECT seq, event_id, type, timestamp, payload
     FROM agent_chat_events WHERE agent_id = ? ORDER BY seq ASC`
  ).all(agentId) as AgentChatEvent[];
}

/** Remove all persisted chat events for an agent. */
export function clearAgentChatEvents(agentId: string): void {
  appendEvent(logRoot, 'agent_chat.cleared', { agent_id: agentId });
  db.prepare('DELETE FROM agent_chat_events WHERE agent_id = ?').run(agentId);
  acknowledgeAppliedEvent();
}

// ── Skills ────────────────────────────────────────────────

export function upsertSkill(skill: Skill): void {
  db.prepare(
    `INSERT INTO skills (id, name, description, emoji, folder_path, file_path, schedule, schedule_time, schedule_day, next_run_at, last_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       emoji = excluded.emoji,
       folder_path = excluded.folder_path,
       file_path = excluded.file_path,
       schedule = COALESCE(excluded.schedule, skills.schedule),
       schedule_time = COALESCE(excluded.schedule_time, skills.schedule_time),
       schedule_day = COALESCE(excluded.schedule_day, skills.schedule_day),
       next_run_at = COALESCE(excluded.next_run_at, skills.next_run_at),
       last_run_at = COALESCE(excluded.last_run_at, skills.last_run_at),
       updated_at = excluded.updated_at`
  ).run(skill.id, skill.name, skill.description, skill.emoji, skill.folder, skill.filePath,
        skill.schedule, skill.schedule_time, skill.schedule_day, skill.next_run_at, skill.last_run_at,
        skill.created_at, skill.updated_at);
}

export function removeSkill(id: string): void {
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
}

export function listSkills(): Skill[] {
  return (db.prepare(
    `SELECT id, name, description, emoji, folder_path, file_path, schedule, schedule_time, schedule_day, next_run_at, last_run_at, created_at, updated_at
     FROM skills ORDER BY name ASC`
  ).all() as Array<{ id: string; name: string; description: string; emoji: string; folder_path: string; file_path: string; schedule: string | null; schedule_time: string | null; schedule_day: number | null; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string }>)
    .map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      emoji: row.emoji,
      folder: row.folder_path,
      filePath: row.file_path,
      schedule: row.schedule as Skill['schedule'],
      schedule_time: row.schedule_time,
      schedule_day: row.schedule_day,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
}

export function getSkill(id: string): Skill | null {
  const row = db.prepare(
    `SELECT id, name, description, emoji, folder_path, file_path, schedule, schedule_time, schedule_day, next_run_at, last_run_at, created_at, updated_at
     FROM skills WHERE id = ?`
  ).get(id) as { id: string; name: string; description: string; emoji: string; folder_path: string; file_path: string; schedule: string | null; schedule_time: string | null; schedule_day: number | null; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    emoji: row.emoji,
    folder: row.folder_path,
    filePath: row.file_path,
    schedule: row.schedule as Skill['schedule'],
    schedule_time: row.schedule_time,
    schedule_day: row.schedule_day,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Return skills whose next_run_at is at or before the given UTC timestamp. */
export function getDueSkills(nowUtc: string): Skill[] {
  return (db.prepare(
    `SELECT id, name, description, emoji, folder_path, file_path, schedule, schedule_time, schedule_day, next_run_at, last_run_at, created_at, updated_at
     FROM skills
     WHERE schedule IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
     ORDER BY next_run_at ASC`
  ).all(nowUtc) as Array<{ id: string; name: string; description: string; emoji: string; folder_path: string; file_path: string; schedule: string | null; schedule_time: string | null; schedule_day: number | null; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string }>)
    .map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      emoji: row.emoji,
      folder: row.folder_path,
      filePath: row.file_path,
      schedule: row.schedule as Skill['schedule'],
      schedule_time: row.schedule_time,
      schedule_day: row.schedule_day,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
}

/** Update schedule fields for a skill. */
export function updateSkillSchedule(
  id: string,
  schedule: string | null,
  scheduleTime: string | null,
  scheduleDay: number | null,
  nextRunAt: string | null
): void {
  db.prepare(
    `UPDATE skills SET schedule = ?, schedule_time = ?, schedule_day = ?, next_run_at = ? WHERE id = ?`
  ).run(schedule, scheduleTime, scheduleDay, nextRunAt, id);
}

/** Mark a skill as having just run. */
export function markSkillRun(id: string, lastRunAt: string, nextRunAt: string | null): void {
  db.prepare(
    `UPDATE skills SET last_run_at = ?, next_run_at = ? WHERE id = ?`
  ).run(lastRunAt, nextRunAt, id);
}

/**
 * Atomically claim a scheduled run via CAS on next_run_at.
 * Returns true if this caller won the claim (was able to advance the row),
 * false if another caller/tick already advanced it. This prevents duplicate
 * launches from overlapping scheduler ticks.
 */
export function claimSkillRun(
  id: string,
  expectedNextRunAt: string,
  newLastRunAt: string,
  newNextRunAt: string | null
): boolean {
  const result = db.prepare(
    `UPDATE skills SET last_run_at = ?, next_run_at = ? WHERE id = ? AND next_run_at = ?`
  ).run(newLastRunAt, newNextRunAt, id, expectedNextRunAt);
  return result.changes > 0;
}

/**
 * Return scheduled skills missing a next_run_at — e.g. just rebuilt from disk
 * after restart. Used by the scheduler to recover schedules on startup.
 */
export function getScheduledSkillsNeedingNextRun(): Skill[] {
  return (db.prepare(
    `SELECT id, name, description, emoji, folder_path, file_path, schedule, schedule_time, schedule_day, next_run_at, last_run_at, created_at, updated_at
     FROM skills
     WHERE schedule IS NOT NULL AND next_run_at IS NULL`
  ).all() as Array<{ id: string; name: string; description: string; emoji: string; folder_path: string; file_path: string; schedule: string | null; schedule_time: string | null; schedule_day: number | null; next_run_at: string | null; last_run_at: string | null; created_at: string; updated_at: string }>)
    .map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      emoji: row.emoji,
      folder: row.folder_path,
      filePath: row.file_path,
      schedule: row.schedule as Skill['schedule'],
      schedule_time: row.schedule_time,
      schedule_day: row.schedule_day,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
}

// ── Subagent Records ────────────────────────────────────────

export interface SubagentRecordRow {
  id: string;
  parent_agent_id: string;
  tool_call_id: string | null;
  agent_name: string;
  display_name: string | null;
  description: string | null;
  agent_type: string | null;
  status: string;
  started_at: number;
  completed_at: number | null;
  duration_ms: number | null;
  model: string | null;
  total_tokens: number | null;
  total_tool_calls: number | null;
  error: string | null;
  /** Inline content when small; empty when `streaming_content_path` carries the bytes. */
  streaming_content: string;
  /** Relative path under `.whim/subagent-content/` when content was off-loaded. */
  streaming_content_path: string | null;
  /** Inline turns JSON when small; '[]' when `turns_path` carries the bytes. */
  turns_json: string;
  /** Relative path under `.whim/subagent-content/` when turns_json was off-loaded. */
  turns_path: string | null;
  progress_json: string;
  created_at: string;
  updated_at: string;
}

export interface SubagentToolCallRow {
  id: number;
  subagent_id: string;
  parent_agent_id: string;
  tool_call_id: string | null;
  tool_name: string;
  arguments_json: string | null;
  /** Inline result when small; empty/null when `result_path` carries the bytes. */
  result: string | null;
  /** Relative path under `.whim/subagent-content/` when result was off-loaded. */
  result_path: string | null;
  success: number;
  error: string | null;
  started_at: number | null;
  completed_at: number | null;
  created_at: string;
}

/**
 * Build the event-log payload and DB column values for a sub-agent's
 * heavy text fields. Anything over INLINE_THRESHOLD is written to a side
 * file and the payload carries only the relative path + digest snippet.
 *
 * The shape returned by `dbFields` matches the schema; the shape returned
 * by `eventPayload` is what gets appended to events.jsonl.
 */
function offloadSubagentContent(
  subagentId: string,
  streamingContent: string,
  turnsJson: string,
): {
  eventPayload: {
    streaming_content: string;
    streaming_content_path: string | null;
    streaming_content_digest: ReturnType<typeof refDigest> | null;
    turns_json: string;
    turns_path: string | null;
    turns_digest: ReturnType<typeof refDigest> | null;
  };
  dbFields: {
    streaming_content: string;
    streaming_content_path: string | null;
    turns_json: string;
    turns_path: string | null;
  };
} {
  const streamingRef = storeContent(`${subagentId}.streaming.txt`, streamingContent ?? '');
  const turnsRef = storeContent(`${subagentId}.turns.json`, turnsJson ?? '[]');

  return {
    eventPayload: {
      streaming_content: streamingRef.inline ?? '',
      streaming_content_path: streamingRef.path ?? null,
      streaming_content_digest: refDigest(streamingRef),
      turns_json: turnsRef.inline ?? '[]',
      turns_path: turnsRef.path ?? null,
      turns_digest: refDigest(turnsRef),
    },
    dbFields: {
      streaming_content: streamingRef.inline ?? '',
      streaming_content_path: streamingRef.path ?? null,
      turns_json: turnsRef.inline ?? '[]',
      turns_path: turnsRef.path ?? null,
    },
  };
}

function refDigest(ref: ContentRef): ContentRef['digest'] | null {
  // Only include the digest in the event when content actually moved to a
  // side file — saves bytes for the common small-content case.
  return ref.path ? ref.digest : null;
}

export function createSubagentRecord(record: Omit<SubagentRecordRow, 'created_at' | 'updated_at' | 'streaming_content_path' | 'turns_path'>): void {
  const now = new Date().toISOString();
  const off = offloadSubagentContent(record.id, record.streaming_content, record.turns_json);
  appendEvent(logRoot, 'subagent.created', {
    ...record,
    streaming_content: off.eventPayload.streaming_content,
    streaming_content_path: off.eventPayload.streaming_content_path,
    streaming_content_digest: off.eventPayload.streaming_content_digest,
    turns_json: off.eventPayload.turns_json,
    turns_path: off.eventPayload.turns_path,
    turns_digest: off.eventPayload.turns_digest,
    created_at: now,
    updated_at: now,
  });
  db.prepare(
    `INSERT OR REPLACE INTO subagent_records (id, parent_agent_id, tool_call_id, agent_name, display_name, description, agent_type, status, started_at, completed_at, duration_ms, model, total_tokens, total_tool_calls, error, streaming_content, streaming_content_path, turns_json, turns_path, progress_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id, record.parent_agent_id, record.tool_call_id, record.agent_name,
    record.display_name, record.description, record.agent_type, record.status,
    record.started_at, record.completed_at ?? null, record.duration_ms ?? null,
    record.model ?? null, record.total_tokens ?? null, record.total_tool_calls ?? null,
    record.error ?? null,
    off.dbFields.streaming_content, off.dbFields.streaming_content_path,
    off.dbFields.turns_json, off.dbFields.turns_path,
    record.progress_json ?? '{}', now, now,
  );
  acknowledgeAppliedEvent();
}

export function updateSubagentRecord(
  id: string,
  updates: Partial<Pick<SubagentRecordRow, 'status' | 'completed_at' | 'duration_ms' | 'model' | 'total_tokens' | 'total_tool_calls' | 'error' | 'streaming_content' | 'turns_json' | 'progress_json'>>,
): void {
  requireUpdateTarget('subagent_records', id);
  const now = new Date().toISOString();

  // Off-load heavy fields when they're being updated.
  let off: ReturnType<typeof offloadSubagentContent> | null = null;
  if (updates.streaming_content !== undefined || updates.turns_json !== undefined) {
    off = offloadSubagentContent(
      id,
      updates.streaming_content ?? '',
      updates.turns_json ?? '[]',
    );
  }

  const eventPayload: Record<string, any> = { id, ...updates, updated_at: now };
  if (off) {
    if (updates.streaming_content !== undefined) {
      eventPayload.streaming_content = off.eventPayload.streaming_content;
      eventPayload.streaming_content_path = off.eventPayload.streaming_content_path;
      eventPayload.streaming_content_digest = off.eventPayload.streaming_content_digest;
    }
    if (updates.turns_json !== undefined) {
      eventPayload.turns_json = off.eventPayload.turns_json;
      eventPayload.turns_path = off.eventPayload.turns_path;
      eventPayload.turns_digest = off.eventPayload.turns_digest;
    }
  }
  appendEvent(logRoot, 'subagent.updated', eventPayload);

  const sets: string[] = ['updated_at = ?'];
  const values: any[] = [now];
  for (const [key, val] of Object.entries(updates)) {
    if (key === 'streaming_content' && off) {
      sets.push('streaming_content = ?', 'streaming_content_path = ?');
      values.push(off.dbFields.streaming_content, off.dbFields.streaming_content_path);
    } else if (key === 'turns_json' && off) {
      sets.push('turns_json = ?', 'turns_path = ?');
      values.push(off.dbFields.turns_json, off.dbFields.turns_path);
    } else {
      sets.push(`${key} = ?`);
      values.push(val ?? null);
    }
  }
  values.push(id);
  db.prepare(`UPDATE subagent_records SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  acknowledgeAppliedEvent();
}

export function listSubagentRecords(parentAgentId: string): SubagentRecordRow[] {
  return db.prepare(
    `SELECT * FROM subagent_records WHERE parent_agent_id = ? ORDER BY started_at ASC`
  ).all(parentAgentId) as SubagentRecordRow[];
}

export function createSubagentToolCall(tc: Omit<SubagentToolCallRow, 'id' | 'created_at' | 'result_path'>): void {
  const now = new Date().toISOString();
  const resultRef = storeContent(
    `${tc.subagent_id}.tool-${tc.tool_call_id ?? 'unknown'}.txt`,
    tc.result ?? '',
  );
  const inlineResult = resultRef.inline ?? null;
  const resultPath = resultRef.path ?? null;

  appendEvent(logRoot, 'subagent_tool.created', {
    ...tc,
    result: inlineResult,
    result_path: resultPath,
    result_digest: refDigest(resultRef),
    created_at: now,
  });
  db.prepare(
    `INSERT INTO subagent_tool_calls (subagent_id, parent_agent_id, tool_call_id, tool_name, arguments_json, result, result_path, success, error, started_at, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    tc.subagent_id, tc.parent_agent_id, tc.tool_call_id, tc.tool_name,
    tc.arguments_json, inlineResult, resultPath, tc.success, tc.error ?? null,
    tc.started_at ?? null, tc.completed_at ?? null, now,
  );
  acknowledgeAppliedEvent();
}

export function updateSubagentToolCall(
  subagentId: string,
  toolCallId: string,
  updates: { success: number; result?: string; error?: string; completed_at?: number },
): void {
  if (!db.prepare('SELECT 1 FROM subagent_tool_calls WHERE subagent_id = ? AND tool_call_id = ?').get(subagentId, toolCallId)) {
    throw new Error('Cannot durably update missing subagent tool call');
  }
  const sets: string[] = [];
  const values: any[] = [];

  let inlineResult: string | null | undefined;
  let resultPath: string | null | undefined;
  let resultDigest: ContentRef['digest'] | null | undefined;
  const hasResultUpdate = Object.prototype.hasOwnProperty.call(updates, 'result');
  if (hasResultUpdate) {
    const resultRef = storeContent(
      `${subagentId}.tool-${toolCallId}.txt`,
      updates.result ?? '',
    );
    inlineResult = resultRef.inline ?? null;
    resultPath = resultRef.path ?? null;
    resultDigest = refDigest(resultRef);
  }

  for (const [key, val] of Object.entries(updates)) {
    if (key === 'result') {
      sets.push('result = ?', 'result_path = ?');
      values.push(inlineResult ?? null, resultPath ?? null);
    } else {
      sets.push(`${key} = ?`);
      values.push(val ?? null);
    }
  }
  if (sets.length === 0) return;
  appendEvent(logRoot, 'subagent_tool.updated', {
    subagent_id: subagentId,
    tool_call_id: toolCallId,
    ...updates,
    ...(hasResultUpdate ? { result: inlineResult, result_path: resultPath, result_digest: resultDigest } : {}),
  });
  values.push(subagentId, toolCallId);
  db.prepare(`UPDATE subagent_tool_calls SET ${sets.join(', ')} WHERE subagent_id = ? AND tool_call_id = ?`).run(...values);
  acknowledgeAppliedEvent();
}

export function listSubagentToolCalls(subagentId: string): SubagentToolCallRow[] {
  return db.prepare(
    `SELECT * FROM subagent_tool_calls WHERE subagent_id = ? ORDER BY id ASC`
  ).all(subagentId) as SubagentToolCallRow[];
}
