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
  listSpaces,
  updateSpace,
  getDatabase,
  isInitialized,
} from './database';
import {
  fingerprintPathFor,
  readFingerprint,
  SCHEMA_VERSION,
  computeFingerprint,
  writeFingerprint,
} from './db-fingerprint';
import { listLogFiles } from './log-store';

let testDir: string;
let dbPath: string;
let logRoot: string;

function fresh() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-fingerprint-int-'));
  dbPath = path.join(testDir, 'spaces.db');
  logRoot = path.join(testDir, 'events');
}

beforeEach(() => {
  vi.clearAllMocks();
  fresh();
});

afterEach(() => {
  closeDatabase();
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('initDatabase fingerprint fast path', () => {
  it('upgrades schema-4 history containing the baseline writer\'s missing-row space updates', () => {
    initDatabase(dbPath, logRoot);
    createSpace({ body: 'Obsolete cache contents' });
    closeDatabase();
    const file = listLogFiles(logRoot)[0];
    fs.copyFileSync(path.resolve('src/main/fixtures/legacy-space-noop.jsonl'), file);
    writeFingerprint(fingerprintPathFor(dbPath), { ...computeFingerprint(logRoot, dbPath), schemaVersion: 4 });

    initDatabase(dbPath, logRoot);
    expect(listSpaces()).toMatchObject([{ id: 'legacy-retained', description: 'Retained space' }]);
    expect(readFingerprint(fingerprintPathFor(dbPath))?.schemaVersion).toBe(SCHEMA_VERSION);
    closeDatabase();
    initDatabase(dbPath, logRoot);
    expect(listSpaces().map(space => space.id)).toEqual(['legacy-retained']);
  });

  it('retains a complete final JSON event without LF before admitting another durable save', () => {
    initDatabase(dbPath, logRoot);
    createSpace({ body: 'Before restart' });
    closeDatabase();
    const file = listLogFiles(logRoot).slice(-1)[0]!;
    const ts = new Date().toISOString();
    fs.appendFileSync(file, JSON.stringify({
      ts, op: 'space.create', data: { id: 'unterminated', description: 'Retained complete JSON', created_at: ts, updated_at: ts },
    }));
    initDatabase(dbPath, logRoot);
    expect(listSpaces().some(space => space.id === 'unterminated')).toBe(true);
    createSpace({ body: 'After repaired boundary' });
    closeDatabase();
    fs.unlinkSync(fingerprintPathFor(dbPath));
    initDatabase(dbPath, logRoot);
    expect(listSpaces()).toHaveLength(3);
  });
  it('does not label a remote append as applied when the live database closes', () => {
    initDatabase(dbPath, logRoot);
    createSpace({ body: 'Local' });
    closeDatabase();
    initDatabase(dbPath, logRoot);
    const before = readFingerprint(fingerprintPathFor(dbPath))!;
    const file = listLogFiles(logRoot).slice(-1)[0]!;
    const ts = new Date().toISOString();
    fs.appendFileSync(file, JSON.stringify({
      ts, op: 'space.create', data: { id: 'remote', description: 'Remote', created_at: ts, updated_at: ts },
    }) + '\n');
    expect(listSpaces().some(space => space.id === 'remote')).toBe(false);
    createSpace({ body: 'Local write after remote append' });
    closeDatabase();
    expect(readFingerprint(fingerprintPathFor(dbPath))!.logFiles).toEqual(before.logFiles);
    initDatabase(dbPath, logRoot);
    expect(listSpaces().some(space => space.id === 'remote')).toBe(true);
  });

  it('preserves the last usable cache and fingerprint when a rebuild fails', () => {
    initDatabase(dbPath, logRoot);
    createSpace({ body: 'Saved' });
    closeDatabase();
    initDatabase(dbPath, logRoot);
    closeDatabase();
    const originalDb = fs.readFileSync(dbPath);
    const sidecar = fingerprintPathFor(dbPath);
    const originalFingerprint = fs.readFileSync(sidecar);
    const file = listLogFiles(logRoot).slice(-1)[0]!;
    fs.appendFileSync(file, JSON.stringify({
      ts: new Date().toISOString(), op: 'future.durable_change', data: {},
    }) + '\n');
    expect(() => initDatabase(dbPath, logRoot)).toThrow('Unsupported durable event');
    expect(isInitialized()).toBe(false);
    closeDatabase();
    expect(fs.readFileSync(dbPath)).toEqual(originalDb);
    expect(fs.readFileSync(sidecar)).toEqual(originalFingerprint);
    expect(fs.readdirSync(testDir).filter(file => file.includes('.rebuild-'))).toEqual([]);
  });

  it('never fingerprints a failed local apply as successfully materialized', () => {
    initDatabase(dbPath, logRoot);
    getDatabase().exec(`CREATE TRIGGER reject_space BEFORE INSERT ON spaces BEGIN SELECT RAISE(ABORT, 'Injected SQL failure'); END`);
    expect(() => createSpace({ body: 'Durably logged before failed apply' })).toThrow('Injected SQL failure');
    closeDatabase();
    initDatabase(dbPath, logRoot);
    expect(listSpaces()).toHaveLength(1);
    expect(listSpaces()[0].description).toBe('Durably logged before failed apply');
  });

  it('quarantines torn bytes before acknowledging new appends and checkpointing', () => {
    initDatabase(dbPath, logRoot);
    createSpace({ body: 'Saved before torn append' });
    closeDatabase();
    const file = listLogFiles(logRoot).slice(-1)[0]!;
    fs.appendFileSync(file, '{"ts":');
    initDatabase(dbPath, logRoot);
    expect(listSpaces()).toHaveLength(1);
    const quarantine = fs.readdirSync(path.dirname(file)).find(name => name.includes('.torn-'))!;
    expect(fs.readFileSync(path.join(path.dirname(file), quarantine), 'utf8')).toBe('{"ts":');
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
    createSpace({ body: 'Acknowledged after recovery' });
    closeDatabase();
    expect(readFingerprint(fingerprintPathFor(dbPath))).not.toBeNull();
    fs.unlinkSync(fingerprintPathFor(dbPath));
    initDatabase(dbPath, logRoot);
    expect(listSpaces()).toHaveLength(2);
  });

  it('cannot acknowledge past a failed SQL apply when later local writes succeed', () => {
    initDatabase(dbPath, logRoot);
    getDatabase().exec(`CREATE TRIGGER reject_space BEFORE INSERT ON spaces BEGIN SELECT RAISE(ABORT, 'Injected SQL failure'); END`);
    expect(() => createSpace({ body: 'First logged event' })).toThrow('Injected SQL failure');
    getDatabase().exec('DROP TRIGGER reject_space');
    createSpace({ body: 'Later successfully applied event' });
    closeDatabase();
    initDatabase(dbPath, logRoot);
    expect(listSpaces()).toHaveLength(2);
  });

  it('writes a sidecar after a fresh build', () => {
    initDatabase(dbPath, logRoot);
    createSpace({ body: 'Hello' });
    closeDatabase();

    initDatabase(dbPath, logRoot);
    closeDatabase();

    const sidecar = fingerprintPathFor(dbPath);
    expect(fs.existsSync(sidecar)).toBe(true);
    const fp = readFingerprint(sidecar);
    expect(fp).not.toBeNull();
    expect(fp!.schemaVersion).toBe(SCHEMA_VERSION);
    expect(fp!.db?.path).toBe(dbPath);
    expect(fp!.logFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('reuses the cached DB when the log + DB are unchanged', async () => {
    // Seed: create one space, then close.
    initDatabase(dbPath, logRoot);
    const space = createSpace({ body: 'Persistent' });
    closeDatabase();
    // Spy on replayLog to prove the fast path skipped it.
    const eventlog = await import('./eventlog');
    const replaySpy = vi.spyOn(eventlog, 'replayLog');

    initDatabase(dbPath, logRoot);
    const spaces = listSpaces();
    expect(spaces.find((s) => s.id === space.id)).toBeDefined();
    expect(replaySpy).not.toHaveBeenCalled();

    replaySpy.mockRestore();
    closeDatabase();
  });

  it('falls back to rebuild when the log changes between sessions', () => {
    initDatabase(dbPath, logRoot);
    createSpace({ body: 'First' });
    closeDatabase();

    // Simulate another process / window appending to the log while the DB
    // is closed — e.g., a sibling client that synced new events via git.
    initDatabase(dbPath, logRoot);
    createSpace({ body: 'Second' });
    closeDatabase();

    // Tamper with the sidecar's recorded DB stats to force a mismatch.
    // (Realistically the previous close already updated the sidecar to
    // match, so we synthesise a mismatch by appending more events
    // without invoking initDatabase again, then check the next init.)
    const sidecar = fingerprintPathFor(dbPath);
    const fpBefore = readFingerprint(sidecar)!;
    const segments = listLogFiles(logRoot);
    expect(segments.length).toBeGreaterThan(0);
    // Append a raw event to the last segment to simulate an out-of-band write.
    const lastSegment = segments[segments.length - 1];
    fs.appendFileSync(lastSegment,
      JSON.stringify({
        ts: '2099-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'third-id',
          description: 'Third (out of band)',
          body: 'Third',
          status: 'captured',
          attachments: '[]',
          folder: 'third-folder',
          created_at: '2099-01-01T00:00:00.000Z',
          updated_at: '2099-01-01T00:00:00.000Z',
        },
      }) + '\n',
    );

    initDatabase(dbPath, logRoot);
    // The replay must have picked up the appended event.
    expect(listSpaces().some((s) => s.id === 'third-id')).toBe(true);

    // A fresh sidecar should reflect the new state.
    const fpAfter = readFingerprint(sidecar)!;
    expect(fpAfter.logFiles[0].sha256).not.toBe(fpBefore.logFiles[0].sha256);
    closeDatabase();
  });

  it('falls back to rebuild when the DB file is replaced externally', () => {
    initDatabase(dbPath, logRoot);
    const space = createSpace({ body: 'Original' });
    closeDatabase();

    // Replace the DB file with garbage to simulate corruption / tampering.
    fs.writeFileSync(dbPath, 'not a real db');

    // initDatabase should notice the DB file changed → replay the log
    // and write a fresh, queryable cache.
    initDatabase(dbPath, logRoot);
    const spaces = listSpaces();
    expect(spaces.find((s) => s.id === space.id)).toBeDefined();
    closeDatabase();
  });

  it('falls back to rebuild when the sidecar is missing', () => {
    initDatabase(dbPath, logRoot);
    const space = createSpace({ body: 'A space' });
    closeDatabase();

    fs.unlinkSync(fingerprintPathFor(dbPath));

    initDatabase(dbPath, logRoot);
    expect(listSpaces().find((s) => s.id === space.id)).toBeDefined();
    closeDatabase();
  });

  it('persists updates through the fast path round-trip', () => {
    initDatabase(dbPath, logRoot);
    const space = createSpace({ body: 'V1' });
    updateSpace(space.id, { description: 'V2' });
    closeDatabase();

    initDatabase(dbPath, logRoot);
    const reloaded = listSpaces().find((s) => s.id === space.id)!;
    expect(reloaded.description).toBe('V2');
    closeDatabase();
  });
});
