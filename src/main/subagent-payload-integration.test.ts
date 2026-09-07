import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
vi.mock('./storage', async () => {
  const db = await import('./database');
  const { resolveContent } = await import('./subagent-content-store');
  return {
    ...db,
    listSubagentRecords: (id: string) => db.listSubagentRecords(id).map(row => ({
      ...row,
      streaming_content: resolveContent({ inline: row.streaming_content, path: row.streaming_content_path }),
      turns_json: resolveContent({ inline: row.turns_json, path: row.turns_path }),
    })),
    listSubagentToolCalls: (id: string) => db.listSubagentToolCalls(id).map(row => ({
      ...row, result: resolveContent({ inline: row.result, path: row.result_path }),
    })),
  };
});

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
  createSubagentRecord,
  updateSubagentRecord,
  createSubagentToolCall,
  updateSubagentToolCall,
  listSubagentRecords,
  listSubagentToolCalls,
} from './database';
import { SubagentTracker } from './subagent-service';
import { INLINE_THRESHOLD } from './subagent-content-store';
import { listLogFiles } from './log-store';

let testDir: string;
let dbPath: string;
let eventLogPath: string;
let contentDir: string;

function setup() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-payload-int-'));
  dbPath = path.join(testDir, 'spaces.db');
  eventLogPath = path.join(testDir, 'events');
  contentDir = path.join(testDir, 'subagent-content');
  initDatabase(dbPath, eventLogPath);
}

beforeEach(() => {
  vi.clearAllMocks();
  setup();
});

afterEach(() => {
  closeDatabase();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('subagent payload off-loading (DB ↔ event log ↔ side files)', () => {
  it('keeps short streaming content + turns inline', () => {
    createSubagentRecord({
      id: 'a1',
      parent_agent_id: 'p1',
      tool_call_id: 'tc1',
      agent_name: 'explore',
      display_name: 'Explore',
      description: '',
      agent_type: 'explore',
      status: 'completed',
      started_at: 1000,
      completed_at: 2000,
      duration_ms: 1000,
      model: 'gpt-x',
      total_tokens: 10,
      total_tool_calls: 1,
      error: null,
      streaming_content: 'short',
      turns_json: '[]',
      progress_json: '{}',
    });

    const rows = listSubagentRecords('p1');
    expect(rows).toHaveLength(1);
    expect(rows[0].streaming_content).toBe('short');
    expect(rows[0].streaming_content_path).toBeNull();
    expect(rows[0].turns_json).toBe('[]');
    expect(rows[0].turns_path).toBeNull();

    // No side files should have been created for short payloads.
    if (fs.existsSync(contentDir)) {
      expect(fs.readdirSync(contentDir)).toEqual([]);
    }
  });

  it('off-loads large streaming content to a side file and clears the inline column', () => {
    const big = 'x'.repeat(INLINE_THRESHOLD + 500);
    createSubagentRecord({
      id: 'a2',
      parent_agent_id: 'p1',
      tool_call_id: 'tc2',
      agent_name: 'explore',
      display_name: 'Explore',
      description: '',
      agent_type: 'explore',
      status: 'completed',
      started_at: 1000,
      completed_at: 2000,
      duration_ms: 1000,
      model: null,
      total_tokens: null,
      total_tool_calls: null,
      error: null,
      streaming_content: big,
      turns_json: '[]',
      progress_json: '{}',
    });

    const rows = listSubagentRecords('p1');
    expect(rows[0].streaming_content).toBe('');
    expect(rows[0].streaming_content_path).toMatch(/^a2\.streaming\.txt\.[a-f0-9]{64}$/);
    const onDisk = fs.readFileSync(path.join(contentDir, rows[0].streaming_content_path!), 'utf8');
    expect(onDisk).toBe(big);
  });

  it('off-loads a fat turns_json blob to a side file', () => {
    const turn = { turnIndex: 0, response: 'y'.repeat(INLINE_THRESHOLD + 500), timestamp: 1 };
    const turnsJson = JSON.stringify([turn]);
    createSubagentRecord({
      id: 'a3',
      parent_agent_id: 'p1',
      tool_call_id: 'tc3',
      agent_name: 'task',
      display_name: 'Task',
      description: '',
      agent_type: 'task',
      status: 'completed',
      started_at: 1,
      completed_at: 2,
      duration_ms: 1,
      model: null,
      total_tokens: null,
      total_tool_calls: null,
      error: null,
      streaming_content: '',
      turns_json: turnsJson,
      progress_json: '{}',
    });

    const rows = listSubagentRecords('p1');
    expect(rows[0].turns_json).toBe('[]');
    expect(rows[0].turns_path).toMatch(/^a3\.turns\.json\.[a-f0-9]{64}$/);
    const onDisk = fs.readFileSync(path.join(contentDir, rows[0].turns_path!), 'utf8');
    expect(JSON.parse(onDisk)).toEqual([turn]);
  });

  it('updateSubagentRecord publishes an immutable side file when content grows', () => {
    createSubagentRecord({
      id: 'a4',
      parent_agent_id: 'p1',
      tool_call_id: 'tc4',
      agent_name: 'explore',
      display_name: 'Explore',
      description: '',
      agent_type: 'explore',
      status: 'running',
      started_at: 1,
      completed_at: null,
      duration_ms: null,
      model: null,
      total_tokens: null,
      total_tool_calls: null,
      error: null,
      streaming_content: '',
      turns_json: '[]',
      progress_json: '{}',
    });

    // Initial state: no side file.
    const initial = listSubagentRecords('p1');
    expect(initial[0].streaming_content_path).toBeNull();

    const big = 'z'.repeat(INLINE_THRESHOLD + 1);
    updateSubagentRecord('a4', {
      status: 'completed',
      streaming_content: big,
      turns_json: '[]',
    });

    const after = listSubagentRecords('p1');
    expect(after[0].streaming_content).toBe('');
    expect(after[0].streaming_content_path).toMatch(/^a4\.streaming\.txt\.[a-f0-9]{64}$/);
    expect(after[0].status).toBe('completed');
    expect(fs.readFileSync(path.join(contentDir, after[0].streaming_content_path!), 'utf8')).toBe(big);
  });

  it('off-loads large tool call results', () => {
    // Tool calls require a parent record for FK integrity.
    createSubagentRecord({
      id: 's1',
      parent_agent_id: 'p1',
      tool_call_id: 'tcall-1',
      agent_name: 'task',
      display_name: 'Task',
      description: '',
      agent_type: 'task',
      status: 'running',
      started_at: 1,
      completed_at: null,
      duration_ms: null,
      model: null,
      total_tokens: null,
      total_tool_calls: null,
      error: null,
      streaming_content: '',
      turns_json: '[]',
      progress_json: '{}',
    });

    createSubagentToolCall({
      subagent_id: 's1',
      parent_agent_id: 'p1',
      tool_call_id: 'tcall-1',
      tool_name: 'shell',
      arguments_json: '{}',
      result: null,
      success: 1,
      error: null,
      started_at: 1,
      completed_at: null,
    });

    const big = 'q'.repeat(INLINE_THRESHOLD + 200);
    updateSubagentToolCall('s1', 'tcall-1', {
      success: 1,
      result: big,
      completed_at: 2,
    });

    const calls = listSubagentToolCalls('s1');
    expect(calls).toHaveLength(1);
    expect(calls[0].result).toBeNull();
    expect(calls[0].result_path).toMatch(/^s1\.tool-tcall-1\.txt\.[a-f0-9]{64}$/);
    expect(fs.readFileSync(path.join(contentDir, calls[0].result_path!), 'utf8')).toBe(big);
  });

  it('loadPersistedSubagents stitches inline + side-file content back together', async () => {
    const big = 'h'.repeat(INLINE_THRESHOLD + 100);
    const turn = { turnIndex: 0, response: 'k'.repeat(INLINE_THRESHOLD + 100), timestamp: 5 };
    createSubagentRecord({
      id: 'a5',
      parent_agent_id: 'p2',
      tool_call_id: 'tc5',
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
      turns_json: JSON.stringify([turn]),
      progress_json: '{}',
    });

    const tracker = new SubagentTracker();
    const loaded = (await tracker.loadPersistedSubagents('p2'));
    expect(loaded).toHaveLength(1);
    expect(loaded[0].streamingContent).toBe(big);
    expect(loaded[0].turns).toEqual([turn]);
  });

  it('event log payload omits the heavy content when off-loaded', () => {
    const big = 'w'.repeat(INLINE_THRESHOLD + 1000);
    createSubagentRecord({
      id: 'a6',
      parent_agent_id: 'p3',
      tool_call_id: 'tc6',
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

    // Concatenate every segment in the rotated log tree.
    const raw = listLogFiles(eventLogPath)
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('');
    // The log should reference the path, not embed the big string.
    expect(raw).toMatch(/"streaming_content_path":"a6\.streaming\.txt\.[a-f0-9]{64}"/);
    expect(raw).not.toContain(big);
    // And it must be much smaller than the inlined alternative.
    expect(raw.length).toBeLessThan(big.length / 2);
  });
});
