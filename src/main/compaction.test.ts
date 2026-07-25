import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/electron-path' },
}));

vi.mock('./workspace', () => ({
  readCanvas: vi.fn(() => ''),
  slugify: vi.fn((text: string, spaceId: string) => {
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'space';
    return `${slug}-${spaceId.replace(/-/g, '').slice(0, 4)}`;
  }),
}));

import {
  initDatabase,
  closeDatabase,
  createSpace,
  createCanvasAgent,
  createAgentSession,
  createSubagentRecord,
  createSubagentToolCall,
  listSpaces,
  listCanvasAgents,
  listAgentSessions,
  listSubagentRecords,
  listSubagentToolCalls,
} from './database';
import {
  compactOldSegments,
  KEEP_WINDOW_MS,
  LOCK_FILENAME,
} from './compaction';
import { SNAPSHOT_FILENAME, segmentFilename } from './log-store';
import { INLINE_THRESHOLD } from './subagent-content-store';
import type { CanvasAgent, AgentSession } from '../shared/types';

let tmpDir: string;
let dbPath: string;
let logRoot: string;

function fresh() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-test-'));
  dbPath = path.join(tmpDir, 'spaces.db');
  logRoot = path.join(tmpDir, 'events');
}

/** Seed a cold segment file directly (bypasses appendEvent) with a
 *  controllable ts so the cold-detection logic exercises real data. */
function seedSegment(bucket: string, segNum: number, events: object[]): string {
  const dir = path.join(logRoot, bucket);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, segmentFilename(segNum));
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  fresh();
});

afterEach(() => {
  closeDatabase();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('compactOldSegments', () => {
  it('is a no-op when the log tree does not exist', () => {
    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('no-segments');
  });

  it('is a no-op when every segment is still within the keep window', () => {
    // Seed a segment with events in the very recent past.
    const recent = new Date().toISOString();
    seedSegment('2099-12', 1, [
      { ts: recent, op: 'space.create', data: { id: 'a', description: 'A', body: 'A', status: 'captured', created_at: recent, updated_at: recent } },
    ]);
    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('nothing-to-compact');
  });

  it('folds an old segment into snapshot.jsonl and deletes the segment', () => {
    // Need a DB so the snapshot writer can call into the content store.
    initDatabase(dbPath, logRoot);
    closeDatabase();

    // Seed a 2024 segment with a space.create event.
    const oldTs = '2024-01-15T00:00:00.000Z';
    const segPath = seedSegment('2024-01', 1, [
      { ts: oldTs, op: 'space.create', data: { id: 'cold-1', description: 'Cold', body: 'Cold body', status: 'captured', attachments: '[]', created_at: oldTs, updated_at: oldTs } },
    ]);
    expect(fs.existsSync(segPath)).toBe(true);

    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(true);
    expect(result.compactedSegments).toBe(1);

    // Snapshot file now exists at the tree root.
    const snapshot = path.join(logRoot, SNAPSHOT_FILENAME);
    expect(fs.existsSync(snapshot)).toBe(true);

    // Snapshot payload encodes the row.
    const snapEvent = JSON.parse(fs.readFileSync(snapshot, 'utf8').trim());
    expect(snapEvent.op).toBe('snapshot');
    expect(snapEvent.data.spaces).toHaveLength(1);
    expect(snapEvent.data.spaces[0].id).toBe('cold-1');

    // Cold segment is gone, empty bucket cleaned up.
    expect(fs.existsSync(segPath)).toBe(false);
    expect(fs.existsSync(path.join(logRoot, '2024-01'))).toBe(false);
  });

  it('keeps recent segments untouched while compacting old ones', () => {
    initDatabase(dbPath, logRoot);
    closeDatabase();

    const oldTs = '2024-01-15T00:00:00.000Z';
    const recentTs = new Date().toISOString();

    const oldSegment = seedSegment('2024-01', 1, [
      { ts: oldTs, op: 'space.create', data: { id: 'cold', description: 'Cold', body: 'Cold body', status: 'captured', attachments: '[]', created_at: oldTs, updated_at: oldTs } },
    ]);
    const recentSegment = seedSegment('2099-12', 1, [
      { ts: recentTs, op: 'space.create', data: { id: 'hot', description: 'Hot', body: 'Hot body', status: 'captured', attachments: '[]', created_at: recentTs, updated_at: recentTs } },
    ]);

    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(true);
    expect(result.compactedSegments).toBe(1);

    expect(fs.existsSync(oldSegment)).toBe(false);
    expect(fs.existsSync(recentSegment)).toBe(true);
  });

  it('produces a snapshot that replays correctly into a fresh DB', () => {
    initDatabase(dbPath, logRoot);
    const space = createSpace({ body: 'Will survive compaction' });
    closeDatabase();

    // Move the active segment into a "cold" bucket so compaction picks it up.
    const segments = fs.readdirSync(logRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(segments).toHaveLength(1);
    const liveBucket = segments[0];
    const livePath = path.join(logRoot, liveBucket, 'events-001.jsonl');
    const content = fs.readFileSync(livePath, 'utf8');
    // Re-stamp every event with an old ts so isSegmentCold flips it.
    const oldTs = '2024-01-15T00:00:00.000Z';
    const lines = content.split('\n').filter(Boolean).map((line) => {
      const event = JSON.parse(line);
      event.ts = oldTs;
      return JSON.stringify(event);
    });
    fs.rmSync(path.join(logRoot, liveBucket), { recursive: true, force: true });
    seedSegment('2024-01', 1, lines.map((l) => JSON.parse(l)));

    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(true);

    // Reload from scratch.
    fs.unlinkSync(dbPath);
    initDatabase(dbPath, logRoot);
    const reloaded = listSpaces().find((s) => s.id === space.id);
    expect(reloaded).toBeDefined();
    expect(reloaded!.body).toBe('# Will survive compaction');
  });

  it('extended snapshot payload covers canvas_agents, agent_sessions, subagents, tool calls', () => {
    initDatabase(dbPath, logRoot);
    const space = createSpace({ body: 'Carrier' });
    const canvasAgent: CanvasAgent = {
      id: 'ca-1',
      space_id: space.id,
      selected_text: 'snippet',
      session_id: 'sess-1',
      pid: null,
      status: 'completed',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    createCanvasAgent(canvasAgent);

    const session: AgentSession = {
      id: 'as-1',
      session_id: 'sess-2',
      space_id: space.id,
      prompt: 'do thing',
      status: 'completed',
      summary: 'done',
      working_dir: null,
      source: 'cca',
      persona_handle: null,
      quoted_text: null,
      run_location: 'cloud',
      cca_job_id: 'job-compact',
      cca_repository: 'upstream/repo',
      cca_effective_repository: 'fork/repo',
      cca_fallback_json: '{"reason":"sso_blocked"}',
      cca_result_json: '{"status":"completed"}',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    };
    createAgentSession(session);

    createSubagentRecord({
      id: 'sa-1',
      parent_agent_id: 'parent-1',
      tool_call_id: 'tc-sa-1',
      agent_name: 'explore',
      display_name: 'Explore',
      description: '',
      agent_type: 'explore',
      status: 'completed',
      started_at: 1,
      completed_at: 2,
      duration_ms: 1,
      model: null,
      total_tokens: null,
      total_tool_calls: null,
      error: null,
      streaming_content: '',
      turns_json: '[]',
      progress_json: '{}',
    });
    createSubagentToolCall({
      subagent_id: 'sa-1',
      parent_agent_id: 'parent-1',
      tool_call_id: 'tcall-1',
      tool_name: 'shell',
      arguments_json: '{}',
      result: null,
      success: 1,
      error: null,
      started_at: 1,
      completed_at: 2,
    });
    closeDatabase();

    // Stamp the live segment as old.
    const liveBucket = fs.readdirSync(logRoot).find((e) => /^\d{4}-\d{2}$/.test(e))!;
    const livePath = path.join(logRoot, liveBucket, 'events-001.jsonl');
    const lines = fs.readFileSync(livePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      const event = JSON.parse(line);
      event.ts = '2024-01-15T00:00:00.000Z';
      return event;
    });
    fs.rmSync(path.join(logRoot, liveBucket), { recursive: true, force: true });
    seedSegment('2024-01', 1, lines);

    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(true);

    // Replay the snapshot into a fresh DB and verify every entity returned.
    fs.unlinkSync(dbPath);
    initDatabase(dbPath, logRoot);
    expect(listSpaces().find((s) => s.id === space.id)).toBeDefined();
    expect(listCanvasAgents(space.id)).toHaveLength(1);
    const restoredSession = listAgentSessions().find((s) => s.id === 'as-1');
    expect(restoredSession).toMatchObject({
      cca_job_id: 'job-compact',
      cca_repository: 'upstream/repo',
      cca_effective_repository: 'fork/repo',
      cca_fallback_json: '{"reason":"sso_blocked"}',
      cca_result_json: '{"status":"completed"}',
    });
    expect(listSubagentRecords('parent-1')).toHaveLength(1);
    expect(listSubagentToolCalls('sa-1')).toHaveLength(1);
  });

  it('garbage-collects side files for compacted subagents', () => {
    initDatabase(dbPath, logRoot);
    const big = 'x'.repeat(INLINE_THRESHOLD + 200);
    createSubagentRecord({
      id: 'sa-gc',
      parent_agent_id: 'parent-gc',
      tool_call_id: 'tc-gc',
      agent_name: 'explore',
      display_name: 'Explore',
      description: '',
      agent_type: 'explore',
      status: 'completed',
      started_at: 1,
      completed_at: 2,
      duration_ms: 1,
      model: null,
      total_tokens: null,
      total_tool_calls: null,
      error: null,
      streaming_content: big,
      turns_json: '[]',
      progress_json: '{}',
    });
    const sideFile = path.join(tmpDir, 'subagent-content', 'sa-gc.streaming.txt');
    expect(fs.existsSync(sideFile)).toBe(true);
    closeDatabase();

    // Make the segment cold.
    const liveBucket = fs.readdirSync(logRoot).find((e) => /^\d{4}-\d{2}$/.test(e))!;
    const livePath = path.join(logRoot, liveBucket, 'events-001.jsonl');
    const lines = fs.readFileSync(livePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      const event = JSON.parse(line);
      event.ts = '2024-01-15T00:00:00.000Z';
      return event;
    });
    fs.rmSync(path.join(logRoot, liveBucket), { recursive: true, force: true });
    seedSegment('2024-01', 1, lines);

    // Re-init the DB so the content-store dir module variable is live
    // again for the deleteContent call inside compaction.
    initDatabase(dbPath, logRoot);
    closeDatabase();
    initDatabase(dbPath, logRoot);

    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(true);
    expect(result.removedSideFiles).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(sideFile)).toBe(false);
    closeDatabase();
  });

  it('respects the advisory lock file', () => {
    // Pre-create the lock to simulate another process compacting.
    fs.mkdirSync(logRoot, { recursive: true });
    fs.writeFileSync(path.join(logRoot, LOCK_FILENAME), `${process.pid} ${Date.now()}`);

    seedSegment('2024-01', 1, [
      { ts: '2024-01-15T00:00:00.000Z', op: 'space.create', data: { id: 'x', description: 'X', body: 'X', status: 'captured', attachments: '[]', created_at: '2024-01-15T00:00:00.000Z', updated_at: '2024-01-15T00:00:00.000Z' } },
    ]);

    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('locked');
  });

  it('reclaims a stale lock that nobody is holding', () => {
    initDatabase(dbPath, logRoot);
    closeDatabase();

    // Pre-create a stale lock (mtime well in the past).
    fs.mkdirSync(logRoot, { recursive: true });
    const lockFile = path.join(logRoot, LOCK_FILENAME);
    fs.writeFileSync(lockFile, 'stale');
    const ancient = Date.now() - 60 * 60 * 1000; // 1 hour old
    fs.utimesSync(lockFile, ancient / 1000, ancient / 1000);

    seedSegment('2024-01', 1, [
      { ts: '2024-01-15T00:00:00.000Z', op: 'space.create', data: { id: 'reclaim', description: 'Reclaim', body: 'Reclaim', status: 'captured', attachments: '[]', created_at: '2024-01-15T00:00:00.000Z', updated_at: '2024-01-15T00:00:00.000Z' } },
    ]);

    const result = compactOldSegments(logRoot);
    expect(result.ran).toBe(true);
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});
