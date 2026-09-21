import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import Database from 'better-sqlite3';
import { compactOldSegments } from './compaction';
import { replayLog, type LogEvent } from './eventlog';
import { createPersistenceSchema } from './persistence-schema';
import { readLines, readSnapshotManifest, snapshotChunkFiles } from './persistence-snapshot';
import { listLogFiles, MAX_SEGMENT_BYTES } from './log-store';
import { computeFingerprint } from './db-fingerprint';

vi.mock('fs', async original => ({ ...await original<typeof import('fs')>() }));

let directory: string;
let logRoot: string;
let db: Database.Database;
const old = '2024-01-01T00:00:00.000Z';
const now = new Date('2026-09-07T00:00:00.000Z');
const hot = '2026-08-30T00:00:00.000Z';

function event(op: string, data: Record<string, unknown>, ts = old): LogEvent {
  return { ts, op, data };
}

function seed(bucket: string, events: LogEvent[], number = 1): string {
  const file = path.join(logRoot, bucket, `events-${String(number).padStart(3, '0')}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, events.map(e => JSON.stringify(e) + '\n').join(''));
  return file;
}

function subagent(id = 'child', side?: string): LogEvent {
  return event('subagent.created', {
    id, parent_agent_id: 'parent', agent_name: 'explore', started_at: 1,
    streaming_content: side ? '' : 'expired inline', streaming_content_path: side,
    total_tokens: 456, total_tool_calls: 2, created_at: old, updated_at: old,
  });
}

function tool(id = 'tool', side?: string): LogEvent {
  return event('subagent_tool.created', {
    subagent_id: 'child', parent_agent_id: 'parent', tool_call_id: id,
    tool_name: 'read', result_path: side, created_at: old,
  });
}

function space(): LogEvent {
  return event('space.create', { id: 'space', description: 'Before', created_at: old, updated_at: old });
}

function compact() {
  return compactOldSegments(logRoot, { now });
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-compaction-recovery-'));
  logRoot = path.join(directory, 'events');
  db = new Database(':memory:');
  createPersistenceSchema(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('durable compaction recovery', () => {
  it('publishes bounded snapshot shards crash-safely and fingerprints every referenced chunk', () => {
    let firstSegment = '';
    for (let segment = 1; segment <= 2; segment++) {
      const file = seed('2024-01', segment === 1 ? [subagent(), tool()] : [], segment);
      if (segment === 1) firstSegment = file;
      const fd = fs.openSync(file, 'a');
      try {
        for (let i = 0; i < 1800; i++) {
          fs.writeSync(fd, JSON.stringify(event('agent_chat.appended', {
            agent_id: 'parent', seq: (segment - 1) * 1800 + i + 1,
            type: 'assistant.message', timestamp: old, payload: 'x'.repeat(8192),
          })) + '\n');
        }
      } finally {
        fs.closeSync(fd);
      }
    }
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (file === firstSegment) throw new Error('Injected interruption after sharded snapshot publication');
      return unlink(file);
    });
    expect(compact().reason).toBe('write-failed');
    vi.restoreAllMocks();
    expect(fs.existsSync(firstSegment)).toBe(true);
    const chunks = snapshotChunkFiles(logRoot);
    expect(chunks.length).toBeGreaterThan(1);
    for (const file of [path.join(logRoot, 'snapshot.jsonl'), ...chunks]) {
      expect(fs.statSync(file).size).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
    }
    const fingerprint = computeFingerprint(logRoot, path.join(directory, 'cache.db'));
    expect(fingerprint.logFiles.map(file => file.path)).toEqual([...listLogFiles(logRoot), ...chunks]);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_chat_events').get()).toEqual({ n: 3600 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagent_tool_calls').get()).toEqual({ n: 1 });
    expect(compact().ran).toBe(true);
    expect(fs.existsSync(firstSegment)).toBe(false);
    // A parseable but altered chunk must not silently supply different content.
    const fd = fs.openSync(snapshotChunkFiles(logRoot)[0], 'r+');
    try { fs.writeSync(fd, 'X', 0); } finally { fs.closeSync(fd); }
    expect(() => replayLog(logRoot, db)).toThrow('Corrupt snapshot chunk');
  }, 15000);

  it('streams a 1000-space fixture into bounded-size snapshot records and reports numeric timings', () => {
    const segment = seed('2024-01', []);
    const fd = fs.openSync(segment, 'a');
    try {
      for (let i = 0; i < 1000; i++) {
        fs.writeSync(fd, JSON.stringify(event('space.create', {
          ...space().data, id: `space-${i}`, body: 'x'.repeat(4096),
        })) + '\n');
        fs.writeSync(fd, JSON.stringify(event('agent_chat.appended', {
          agent_id: 'parent', seq: i + 1, type: 'assistant.message', timestamp: old, payload: 'x'.repeat(8192),
        })) + '\n');
      }
    } finally {
      fs.closeSync(fd);
    }
    const readFile = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].endsWith('.jsonl')) {
        throw new Error('Whole-log read forbidden in streaming regression');
      }
      return Reflect.apply(readFile, fs, args);
    });
    const result = compact();
    expect(result.ran).toBe(true);
    expect(result.inputBytes).toBeGreaterThan(12 * 1024 * 1024);
    let maxRecordBytes = 0;
    let records = 0;
    for (const line of readLines(path.join(logRoot, 'snapshot.jsonl'))) {
      maxRecordBytes = Math.max(maxRecordBytes, Buffer.byteLength(line.text));
      records++;
    }
    expect(maxRecordBytes).toBeLessThan(16 * 1024);
    expect(records).toBe(2002);
    const started = performance.now();
    replayLog(logRoot, db);
    const coldReplayMs = performance.now() - started;
    expect(db.prepare('SELECT COUNT(*) AS n FROM spaces').get()).toEqual({ n: 1000 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_chat_events').get()).toEqual({ n: 1000 });
    console.info('[compaction synthetic]', JSON.stringify({ ...result, spaces: 1000, chatEvents: 1000, coldReplayMs, maxRecordBytes }));
  });

  it('round-trips cold and hot transcript and usage events, including a second compaction', () => {
    const payloads = [
      JSON.stringify({ content: 'Synthetic transcript' }),
      JSON.stringify({ inputTokens: 123, outputTokens: 45, cost: 0.125, model: 'synthetic' }),
    ];
    seed('2024-01', [
      event('agent_session.created', { id: 'parent', session_id: 'session', prompt: 'Synthetic', created_at: old, updated_at: old }),
      ...payloads.map((payload, i) => event('agent_chat.appended', {
        agent_id: 'parent', seq: i + 1, event_id: `event-${i}`, type: i ? 'assistant.usage' : 'assistant.message',
        timestamp: old, payload,
      })),
      subagent(), tool(),
    ]);
    const recent = seed('2026-08', [event('agent_chat.appended', {
      agent_id: 'parent', seq: 3, event_id: 'hot', type: 'user.message', timestamp: hot, payload: '{"content":"Hot"}',
    }, hot)]);
    expect(compact().ran).toBe(true);
    expect(fs.existsSync(recent)).toBe(true);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT payload FROM agent_chat_events ORDER BY seq').all())
      .toEqual([...payloads, '{"content":"Hot"}'].map(payload => ({ payload })));
    expect(db.prepare('SELECT total_tokens, total_tool_calls FROM subagent_records').get())
      .toEqual({ total_tokens: 456, total_tool_calls: 2 });
    expect(compactOldSegments(logRoot, { now: new Date('2026-11-01') }).ran).toBe(true);
    db.close();
    db = new Database(':memory:');
    createPersistenceSchema(db);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_chat_events').get()).toEqual({ n: 3 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagent_tool_calls').get()).toEqual({ n: 1 });
  });

  it('retains every source and publishes nothing on unsupported events or SQL failures', () => {
    const segment = seed('2024-01', [space(), event('future.durable_event', { important: true })]);
    const original = fs.readFileSync(segment);
    expect(compact()).toMatchObject({ ran: false, reason: 'write-failed' });
    expect(fs.readFileSync(segment)).toEqual(original);
    expect(fs.existsSync(path.join(logRoot, 'snapshot.jsonl'))).toBe(false);
    fs.writeFileSync(segment, JSON.stringify(event('agent_chat.appended', { seq: 1, payload: '{}' })) + '\n');
    expect(compact()).toMatchObject({ ran: false, reason: 'write-failed' });
    expect(fs.existsSync(segment)).toBe(true);
  });

  it('does not swallow a missing chat table during replay', () => {
    seed('2024-01', [event('agent_chat.appended', {
      agent_id: 'parent', seq: 1, type: 'assistant.usage', timestamp: old, payload: '{}',
    })]);
    db.exec('DROP TABLE agent_chat_events');
    expect(() => replayLog(logRoot, db)).toThrow('no such table: agent_chat_events');
  });

  it('fails closed on unknown snapshot entities and conflicting chat sequences', () => {
    const segment = seed('2024-01', [event('snapshot', { future_entity: [{ id: 1 }] })]);
    expect(compact().reason).toBe('write-failed');
    const chat = event('agent_chat.appended', { agent_id: 'parent', seq: 1, type: 'assistant.message', timestamp: old, payload: 'one' });
    fs.writeFileSync(segment, [chat, { ...chat, data: { ...chat.data, payload: 'two' } }].map(e => JSON.stringify(e) + '\n').join(''));
    expect(compact().reason).toBe('write-failed');
    expect(() => replayLog(logRoot, db)).toThrow('Conflicting agent chat sequence');
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_chat_events').get()).toEqual({ n: 0 });
  });

  it('refuses to compact unapplied updates or unknown snapshot fields', () => {
    const segment = seed('2024-01', [event('space.update', { id: 'missing', fields: { description: 'Cannot apply' } })]);
    expect(compact().reason).toBe('write-failed');
    expect(fs.existsSync(segment)).toBe(true);
    fs.writeFileSync(segment, JSON.stringify(event('snapshot', {
      spaces: [{ ...space().data, future_durable_column: 'preserve me' }],
    })) + '\n');
    expect(compact().reason).toBe('write-failed');
    expect(fs.existsSync(segment)).toBe(true);
  });

  it('compacts baseline-generated missing-row space updates without resurrecting their targets', () => {
    const history = fs.readFileSync(path.resolve('src/main/fixtures/legacy-space-noop.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line) as LogEvent);
    const segment = seed('2026-08', history);
    expect(compact().ran).toBe(true);
    expect(fs.existsSync(segment)).toBe(false);
    expect(replayLog(logRoot, db)).toEqual({ complete: true });
    expect(db.prepare('SELECT id, description FROM spaces').all()).toEqual([
      { id: 'legacy-retained', description: 'Retained space' },
    ]);
  });

  it('replays session-id changes and durable transcript clears in order', () => {
    seed('2024-01', [
      event('agent_session.created', { id: 'parent', session_id: 'old', prompt: 'Synthetic', status: 'completed', created_at: old, updated_at: old }),
      event('agent_session.updated', { id: 'parent', session_id: 'new', updated_at: old }),
      event('agent_chat.appended', { agent_id: 'parent', seq: 1, type: 'assistant.message', timestamp: old, payload: 'old' }),
      event('agent_chat.cleared', { agent_id: 'parent' }),
      event('agent_chat.appended', { agent_id: 'parent', seq: 1, type: 'assistant.message', timestamp: old, payload: 'new' }),
    ]);
    expect(compact().ran).toBe(true);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT session_id, status FROM agent_sessions').get()).toEqual({ session_id: 'new', status: 'completed' });
    expect(db.prepare('SELECT payload FROM agent_chat_events').all()).toEqual([{ payload: 'new' }]);
  });

  it('rejects torn cold segments instead of deleting the unapplied tail', () => {
    const segment = seed('2024-01', [space()]);
    fs.appendFileSync(segment, '{"ts":');
    expect(compact().reason).toBe('write-failed');
    expect(fs.readFileSync(segment, 'utf8')).toContain('{"ts":');
    replayLog(logRoot, db);
    expect(db.prepare('SELECT id FROM spaces').get()).toEqual({ id: 'space' });
  });

  it('survives interruption after publication and before any segment deletion without duplicate tools', () => {
    const segment = seed('2024-01', [subagent(), tool()]);
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (file === segment) throw new Error('Injected crash before unlink');
      return unlink(file);
    });
    expect(compact().reason).toBe('write-failed');
    vi.restoreAllMocks();
    expect(fs.existsSync(segment)).toBe(true);
    expect(readSnapshotManifest(logRoot).covered).toHaveLength(1);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagent_tool_calls').get()).toEqual({ n: 1 });
    expect(compact().ran).toBe(true);
    expect(fs.existsSync(segment)).toBe(false);
  });

  it('survives partial deletion across multiple segments', () => {
    const first = seed('2024-01', [subagent(), tool('one')]);
    const second = seed('2024-02', [tool('two')]);
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (file === second) throw new Error('Injected crash after first unlink');
      return unlink(file);
    });
    expect(compact().reason).toBe('write-failed');
    vi.restoreAllMocks();
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(true);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT tool_call_id FROM subagent_tool_calls ORDER BY id').all())
      .toEqual([{ tool_call_id: 'one' }, { tool_call_id: 'two' }]);
  });

  it('applies only an appended suffix of a covered segment and rejects changed prefixes', () => {
    const segment = seed('2024-01', [subagent(), tool('one')]);
    const original = fs.readFileSync(segment, 'utf8');
    expect(compact().ran).toBe(true);
    fs.mkdirSync(path.dirname(segment), { recursive: true });
    fs.writeFileSync(segment, original + JSON.stringify(tool('two')) + '\n');
    replayLog(logRoot, db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagent_tool_calls').get()).toEqual({ n: 2 });
    expect(compact().ran).toBe(true);
    db.close();
    db = new Database(':memory:');
    createPersistenceSchema(db);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagent_tool_calls').get()).toEqual({ n: 2 });
    fs.mkdirSync(path.dirname(segment), { recursive: true });
    fs.writeFileSync(segment, original.replace('one', 'bad'));
    expect(() => replayLog(logRoot, db)).toThrow('Covered segment conflicts with snapshot');
    expect(compact().reason).toBe('write-failed');
  });

  it('retains the previous snapshot and source when rename fails', () => {
    seed('2024-01', [space()]);
    expect(compact().ran).toBe(true);
    const snapshot = path.join(logRoot, 'snapshot.jsonl');
    const original = fs.readFileSync(snapshot);
    const segment = seed('2024-02', [event('space.update', { id: 'space', fields: { description: 'After' } })]);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('Injected publication failure'); });
    expect(compact().reason).toBe('write-failed');
    expect(fs.readFileSync(snapshot)).toEqual(original);
    expect(fs.existsSync(segment)).toBe(true);
    expect(fs.readdirSync(logRoot).filter(file => file.includes('.tmp-'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('retains sources when the snapshot directory cannot be synced after rename', () => {
    const segment = seed('2024-01', [subagent(), tool()]);
    const sync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('Injected directory sync failure');
      sync(fd);
    });
    expect(compact().reason).toBe('write-failed');
    vi.restoreAllMocks();
    expect(fs.existsSync(segment)).toBe(true);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM subagent_tool_calls').get()).toEqual({ n: 1 });
  });

  it('rejects a parseable snapshot whose row bytes do not match its checksum', () => {
    seed('2024-01', [space()]);
    expect(compact().ran).toBe(true);
    const snapshot = path.join(logRoot, 'snapshot.jsonl');
    fs.writeFileSync(snapshot, fs.readFileSync(snapshot, 'utf8').replace('Before', 'Changed'));
    expect(() => replayLog(logRoot, db)).toThrow('Incomplete or corrupt snapshot');
    expect(db.prepare('SELECT COUNT(*) AS n FROM spaces').get()).toEqual({ n: 0 });
  });

  it('rejects a snapshot missing its footer even when all remaining JSON lines are valid', () => {
    seed('2024-01', [space()]);
    expect(compact().ran).toBe(true);
    const snapshot = path.join(logRoot, 'snapshot.jsonl');
    const lines = fs.readFileSync(snapshot, 'utf8').trim().split('\n');
    fs.writeFileSync(snapshot, lines.slice(0, -1).join('\n') + '\n');
    expect(() => replayLog(logRoot, db)).toThrow('Incomplete snapshot');
    expect(db.prepare('SELECT COUNT(*) AS n FROM spaces').get()).toEqual({ n: 0 });
  });

  it('does not reorder a cold segment after a retained hot segment', () => {
    seed('2024-01', [space()]);
    const first = seed('2024-02', [event('space.update', { id: 'space', fields: { description: 'Hot' } }, hot)]);
    const second = seed('2024-03', [event('space.update', { id: 'space', fields: { description: 'Last' } })]);
    expect(compact().compactedSegments).toBe(1);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT description FROM spaces').get()).toEqual({ description: 'Last' });
  });

  it('uses every event timestamp rather than the final timestamp to determine age', () => {
    const file = seed('2024-01', [space(), event('space.update', { id: 'space', fields: { description: 'Hot' } }, hot), space()]);
    expect(compact().reason).toBe('nothing-to-compact');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('protects hot references and hot subagent updates while retaining the existing cold-content expiry', () => {
    const contentDir = path.join(directory, 'subagent-content');
    fs.mkdirSync(contentDir);
    for (const name of ['shared.txt', 'cold.txt', 'active.txt']) fs.writeFileSync(path.join(contentDir, name), 'synthetic');
    seed('2024-01', [
      subagent('child', 'shared.txt'), subagent('expired', 'cold.txt'), subagent('active', 'active.txt'),
    ]);
    seed('2026-08', [
      event('subagent.created', { ...subagent('hot-child', 'shared.txt').data }, hot),
      event('subagent.updated', { id: 'active', status: 'completed', updated_at: hot }, hot),
    ]);
    expect(compact().removedSideFiles).toBe(1);
    expect(fs.existsSync(path.join(contentDir, 'shared.txt'))).toBe(true);
    expect(fs.existsSync(path.join(contentDir, 'active.txt'))).toBe(true);
    expect(fs.existsSync(path.join(contentDir, 'cold.txt'))).toBe(false);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT streaming_content_path FROM subagent_records WHERE id = ?').get('active'))
      .toEqual({ streaming_content_path: 'active.txt' });
  });

  it('resumes side-file GC after interruption without deleting retained content', () => {
    const contentDir = path.join(directory, 'subagent-content');
    fs.mkdirSync(contentDir);
    const side = path.join(contentDir, 'cold.txt');
    fs.writeFileSync(side, 'synthetic');
    seed('2024-01', [subagent('child', 'cold.txt')]);
    const unlink = fs.unlinkSync;
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (file === side) throw new Error('Injected GC interruption');
      return unlink(file);
    });
    expect(compact().reason).toBe('write-failed');
    vi.restoreAllMocks();
    expect(fs.existsSync(side)).toBe(true);
    expect(compact().removedSideFiles).toBe(1);
    expect(fs.existsSync(side)).toBe(false);
  });

  it('expires superseded cold side-file versions without sweeping unrelated files', () => {
    const contentDir = path.join(directory, 'subagent-content');
    fs.mkdirSync(contentDir);
    for (const name of ['previous.txt', 'current.txt', 'unrelated.txt']) {
      fs.writeFileSync(path.join(contentDir, name), 'synthetic');
    }
    seed('2024-01', [
      subagent('child', 'previous.txt'),
      event('subagent.updated', { id: 'child', streaming_content_path: 'current.txt', updated_at: old }),
    ]);
    expect(compact().removedSideFiles).toBe(2);
    expect(fs.readdirSync(contentDir)).toEqual(['unrelated.txt']);
  });

  it('preserves legacy intent snapshots', () => {
    fs.mkdirSync(logRoot);
    fs.writeFileSync(path.join(logRoot, 'snapshot.jsonl'), JSON.stringify(event('snapshot', {
      intents: [{ ...space().data, status: 'captured' }],
    })) + '\n');
    seed('2024-02', [event('intent.update', { id: 'space', fields: { description: 'Legacy updated' } })]);
    expect(compact().ran).toBe(true);
    replayLog(logRoot, db);
    expect(db.prepare('SELECT description FROM spaces').get()).toEqual({ description: 'Legacy updated' });
  });
});
