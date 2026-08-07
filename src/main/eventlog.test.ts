import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import { appendEvent, replayLog } from './eventlog';
import { resolveActiveSegment } from './log-store';

let tmpDir: string;
/** Root of the rotated event-log tree (`<tmp>/events/`). */
let logRoot: string;
/** Fixed segment file inside the tree where the test pre-seeds raw lines.
 *  Lives under a 2024-01 bucket; replay reads it because listLogFiles
 *  enumerates every bucket. */
let logPath: string;
let db: Database.Database;

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE spaces (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      body TEXT,
      raw_text TEXT,
      client TEXT,
      due_at TEXT,
      due_at_utc TEXT,
      recurrence TEXT,
      completed_at TEXT,
      folder TEXT,
      session_id TEXT,
      source_skill_id TEXT,
      attachments TEXT DEFAULT '[]',
      canvas_content TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'captured',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE canvas_agents (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      selected_text TEXT NOT NULL,
      session_id TEXT NOT NULL,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE agent_sessions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      space_id TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      summary TEXT DEFAULT '',
      working_dir TEXT,
      source TEXT NOT NULL DEFAULT 'sdk',
      persona_handle TEXT,
      quoted_text TEXT,
      comment_thread_id TEXT,
      run_location TEXT NOT NULL DEFAULT 'local',
      cca_job_id TEXT,
      cca_repository TEXT,
      cca_effective_repository TEXT,
      cca_fallback_json TEXT,
      cca_result_json TEXT,
      yolo_mode INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE agent_chat_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_id TEXT,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(agent_id, seq)
    )
  `);

  db.exec(`
    CREATE TABLE space_events (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      due_at TEXT,
      due_at_utc TEXT,
      completed_at TEXT,
      recurrence_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
    )
  `);
}

/** Write raw lines directly to the log file (for testing replayLog). */
function writeLog(lines: object[]): void {
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(logPath, content, 'utf-8');
}

function getSpace(id: string): any {
  return db.prepare('SELECT * FROM spaces WHERE id = ?').get(id);
}

function allSpaces(): any[] {
  return db.prepare('SELECT * FROM spaces').all();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventlog-test-'));
  logRoot = path.join(tmpDir, 'events');
  // Seeded segments live under a fixed bucket so direct fs writes have a
  // stable path; appendEvent calls use logRoot and pick the active segment
  // for the current month (which may differ — replay merges both).
  const bucketDir = path.join(logRoot, '2024-01');
  fs.mkdirSync(bucketDir, { recursive: true });
  logPath = path.join(bucketDir, 'events-001.jsonl');
  db = new Database(':memory:');
  createSchema(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── appendEvent ───────────────────────────────────────────

describe('appendEvent', () => {
  it('writes a JSON line with ts, op, and data fields', () => {
    appendEvent(logRoot, 'space.create', { id: 'abc' });

    const active = resolveActiveSegment(logRoot);
    const content = fs.readFileSync(active, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed).toHaveProperty('ts');
    expect(parsed.op).toBe('space.create');
    expect(parsed.data).toEqual({ id: 'abc' });
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it('appends to existing file content without overwriting', () => {
    appendEvent(logRoot, 'space.create', { id: '1' });
    appendEvent(logRoot, 'space.create', { id: '2' });

    const active = resolveActiveSegment(logRoot);
    const lines = fs.readFileSync(active, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).data.id).toBe('1');
    expect(JSON.parse(lines[1]).data.id).toBe('2');
  });

  it('ends each line with a newline', () => {
    appendEvent(logRoot, 'space.create', { id: '1' });

    const active = resolveActiveSegment(logRoot);
    const content = fs.readFileSync(active, 'utf-8');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('creates the tree and a segment file when none exist yet', () => {
    const newRoot = path.join(tmpDir, 'fresh-events');
    expect(fs.existsSync(newRoot)).toBe(false);

    appendEvent(newRoot, 'test.op', { x: 1 });

    const active = resolveActiveSegment(newRoot);
    expect(fs.existsSync(active)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(active, 'utf-8').trim());
    expect(parsed.op).toBe('test.op');
  });
});

// ── replayLog ─────────────────────────────────────────────

describe('replayLog', () => {
  it('handles missing log root gracefully', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(() => replayLog(missing, db)).not.toThrow();
    expect(allSpaces()).toHaveLength(0);
  });

  it('handles empty log file gracefully', () => {
    fs.writeFileSync(logPath, '', 'utf-8');
    expect(() => replayLog(logRoot, db)).not.toThrow();
    expect(allSpaces()).toHaveLength(0);
  });

  // ── space.create ─────────────────────────────────────

  describe('space.create', () => {
    it('inserts an space into the database', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'i1', description: 'Test space', body: 'Full body',
          raw_text: 'raw', client: 'web', due_at: null, due_at_utc: null,
          recurrence: null, completed_at: null, folder: null,
          attachments: '[]', status: 'captured',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      const space = getSpace('i1');
      expect(space).toBeTruthy();
      expect(space.description).toBe('Test space');
      expect(space.body).toBe('Full body');
      expect(space.status).toBe('captured');
      expect(space.client).toBe('web');
    });

    it('defaults status to "captured" when not provided', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'i2', description: 'No status',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      expect(getSpace('i2').status).toBe('captured');
    });

    it('backfills body from raw_text when body is missing', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'i3', description: 'Old event', raw_text: 'raw text value',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      expect(getSpace('i3').body).toBe('raw text value');
    });

    it('backfills body from description when body and raw_text are missing', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'i4', description: 'Just description',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      expect(getSpace('i4').body).toBe('Just description');
    });

    it('sets body to empty string when body and raw_text are null and description is present', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'i5', description: 'Has description',
          body: null, raw_text: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      // body ?? raw_text ?? description ?? '' → null ?? null ?? 'Has description' → 'Has description'
      expect(getSpace('i5').body).toBe('Has description');
    });
  });

  // ── space.update ─────────────────────────────────────

  describe('space.update', () => {
    beforeEach(() => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'u1', description: 'Original', body: 'Original body',
          status: 'captured',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);
      replayLog(logRoot, db);
    });

    it('updates allowed fields on an space', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'u1', description: 'Original', body: 'Original body',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'space.update',
          data: { id: 'u1', fields: { description: 'Updated', status: 'in_progress' } },
        },
      ]);

      // Re-create DB for clean replay
      db.exec('DELETE FROM spaces');
      replayLog(logRoot, db);

      const space = getSpace('u1');
      expect(space.description).toBe('Updated');
      expect(space.status).toBe('in_progress');
      expect(space.body).toBe('Original body');
    });

    it('skips unknown fields with a warning but does not crash', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'u1', description: 'Original', body: 'Body',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'space.update',
          data: {
            id: 'u1',
            fields: { description: 'Updated', not_a_real_field: 'bad', another_fake: 123 },
          },
        },
      ]);

      db.exec('DELETE FROM spaces');
      expect(() => replayLog(logRoot, db)).not.toThrow();

      const space = getSpace('u1');
      expect(space.description).toBe('Updated');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping unknown field')
      );

      warnSpy.mockRestore();
    });

    it('does nothing when update has only unknown fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'u1', description: 'Original', body: 'Body',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'space.update',
          data: { id: 'u1', fields: { totally_fake: 'nope' } },
        },
      ]);

      db.exec('DELETE FROM spaces');
      expect(() => replayLog(logRoot, db)).not.toThrow();
      expect(getSpace('u1').description).toBe('Original');

      warnSpy.mockRestore();
    });
  });

  // ── space.delete ─────────────────────────────────────

  describe('space.delete', () => {
    it('removes an space from the database', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'd1', description: 'To delete', body: '',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'space.delete',
          data: { id: 'd1' },
        },
      ]);

      replayLog(logRoot, db);
      expect(getSpace('d1')).toBeUndefined();
    });
  });

  // ── space.assign_folder ──────────────────────────────

  describe('space.assign_folder', () => {
    it('updates folder and sets updated_at from event timestamp', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'f1', description: 'Folder test', body: '',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-06-15T12:00:00.000Z',
          op: 'space.assign_folder',
          data: { id: 'f1', folder: '/workspace/projects/cool' },
        },
      ]);

      replayLog(logRoot, db);
      const space = getSpace('f1');
      expect(space.folder).toBe('/workspace/projects/cool');
      expect(space.updated_at).toBe('2024-06-15T12:00:00.000Z');
    });
  });

  // ── Event ordering ────────────────────────────────────

  describe('event ordering', () => {
    it('create → update → delete produces correct final state', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'ord1', description: 'Created', body: '',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'space.update',
          data: { id: 'ord1', fields: { description: 'Updated', status: 'in_progress' } },
        },
        {
          ts: '2024-01-03T00:00:00.000Z',
          op: 'space.delete',
          data: { id: 'ord1' },
        },
      ]);

      replayLog(logRoot, db);
      expect(getSpace('ord1')).toBeUndefined();
      expect(allSpaces()).toHaveLength(0);
    });
  });

  // ── snapshot ──────────────────────────────────────────

  describe('snapshot', () => {
    it('bulk-loads spaces from snapshot', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'snapshot',
        data: {
          spaces: [
            {
              id: 's1', description: 'Snap one', body: 'Body 1', status: 'captured',
              created_at: '2024-01-01T00:00:00.000Z',
              updated_at: '2024-01-01T00:00:00.000Z',
            },
            {
              id: 's2', description: 'Snap two', body: 'Body 2', status: 'done',
              created_at: '2024-01-01T00:00:00.000Z',
              updated_at: '2024-01-01T00:00:00.000Z',
            },
          ],
        },
      }]);

      replayLog(logRoot, db);
      expect(allSpaces()).toHaveLength(2);
      expect(getSpace('s1').description).toBe('Snap one');
      expect(getSpace('s2').status).toBe('done');
    });

    it('bulk-loads space_events from snapshot', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'snapshot',
        data: {
          spaces: [{
            id: 'si1', description: 'Parent', body: '', status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          }],
          space_events: [
            {
              id: 'ie1', space_id: 'si1', event_type: 'due_date_set',
              due_at: '2024-02-01', due_at_utc: '2024-02-01T00:00:00Z',
              created_at: '2024-01-01T00:00:00.000Z',
            },
            {
              id: 'ie2', space_id: 'si1', event_type: 'completed',
              completed_at: '2024-02-15T12:00:00Z',
              created_at: '2024-01-15T00:00:00.000Z',
            },
          ],
        },
      }]);

      replayLog(logRoot, db);
      const events = db.prepare('SELECT * FROM space_events ORDER BY created_at').all() as any[];
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe('ie1');
      expect(events[0].due_at).toBe('2024-02-01');
      expect(events[1].id).toBe('ie2');
      expect(events[1].completed_at).toBe('2024-02-15T12:00:00Z');
    });

    it('snapshot without spaces or space_events does not error', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'snapshot',
        data: {},
      }]);

      expect(() => replayLog(logRoot, db)).not.toThrow();
      expect(allSpaces()).toHaveLength(0);
    });

    it('restores CCA metadata while defaulting legacy snapshot fields to null', () => {
      const base = {
        session_id: 'sid',
        space_id: null,
        prompt: 'p',
        status: 'running',
        summary: '',
        working_dir: '/ws',
        source: 'cca',
        persona_handle: null,
        quoted_text: null,
        run_location: 'cloud',
        created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-01T00:00:00.000Z',
      };
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'snapshot',
        data: {
          agent_sessions: [
            {
              ...base,
              id: 'cca-full',
              cca_job_id: 'job-1',
              cca_repository: 'upstream/repo',
              cca_effective_repository: 'fork/repo',
              cca_fallback_json: '{"reason":"sso_blocked"}',
              cca_result_json: '{"status":"running"}',
            },
            { ...base, id: 'cca-legacy', source: 'cloud' },
          ],
        },
      }]);

      replayLog(logRoot, db);
      const full = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('cca-full') as any;
      expect(full.cca_job_id).toBe('job-1');
      expect(full.cca_repository).toBe('upstream/repo');
      expect(full.cca_effective_repository).toBe('fork/repo');
      expect(full.cca_fallback_json).toContain('sso_blocked');
      expect(full.cca_result_json).toContain('running');

      const legacy = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('cca-legacy') as any;
      expect(legacy.source).toBe('cca');
      expect(legacy.cca_job_id).toBeNull();
      expect(legacy.cca_repository).toBeNull();
      expect(legacy.cca_effective_repository).toBeNull();
      expect(legacy.cca_fallback_json).toBeNull();
      expect(legacy.cca_result_json).toBeNull();
    });
  });

  // ── Corruption tolerance ──────────────────────────────

  describe('corruption tolerance', () => {
    it('ignores a corrupt final line', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const goodLine = JSON.stringify({
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'c1', description: 'Good', body: '',
          status: 'captured',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      });
      fs.writeFileSync(logPath, goodLine + '\n' + '{corrupt json\n', 'utf-8');

      expect(() => replayLog(logRoot, db)).not.toThrow();
      expect(getSpace('c1')).toBeTruthy();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring corrupt final line')
      );

      warnSpy.mockRestore();
    });

    it('throws on corrupt line in the middle (with valid lines after)', () => {
      const goodLine1 = JSON.stringify({
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'c2', description: 'First', body: '',
          status: 'captured',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      });
      const goodLine2 = JSON.stringify({
        ts: '2024-01-02T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'c3', description: 'Third', body: '',
          status: 'captured',
          created_at: '2024-01-02T00:00:00.000Z',
          updated_at: '2024-01-02T00:00:00.000Z',
        },
      });

      fs.writeFileSync(
        logPath,
        goodLine1 + '\n' + '{broken' + '\n' + goodLine2 + '\n',
        'utf-8',
      );

      expect(() => replayLog(logRoot, db)).toThrow(/Corrupt event log at .*:2/);
    });

    /*
     * A snapshot is a single very long line, so when an *apply* failure was
     * misreported as a corrupt final line the whole snapshot was silently
     * dropped — and with it every space the user had. The list came up empty.
     */
    it('does not report an apply failure as a corrupt line', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Well-formed JSON, but the row violates a NOT NULL constraint.
      const line = JSON.stringify({
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'apply-fail', description: null, body: '',
          status: 'captured',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      });
      fs.writeFileSync(logPath, line + '\n', 'utf-8');

      expect(() => replayLog(logRoot, db)).toThrow(/Failed to apply event at .*:1 \(op=space\.create\)/);
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Ignoring corrupt final line')
      );

      warnSpy.mockRestore();
    });
  });

  // ── Orphaned rows ─────────────────────────────────────

  describe('orphaned rows', () => {
    /*
     * Snapshots dump each table wholesale, so one written by an older build
     * can carry child rows whose parent has since been deleted. That used to
     * abort replay with "FOREIGN KEY constraint failed", which meant the app
     * could not start and the space list was empty.
     */
    it('replays a snapshot whose children reference a missing space', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const snapshot = JSON.stringify({
        ts: '2024-01-01T00:00:00.000Z',
        op: 'snapshot',
        data: {
          spaces: [{
            id: 'live', description: 'Live space', body: '',
            status: 'captured', attachments: '[]',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          }],
          space_events: [
            { id: 'e1', space_id: 'live', event_type: 'created', created_at: '2024-01-01T00:00:00.000Z' },
            { id: 'e2', space_id: 'deleted-long-ago', event_type: 'created', created_at: '2024-01-01T00:00:00.000Z' },
          ],
          canvas_agents: [{
            id: 'a1', space_id: 'also-gone', selected_text: 't', session_id: 's',
            status: 'completed',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          }],
        },
      });
      fs.writeFileSync(logPath, snapshot + '\n', 'utf-8');

      expect(() => replayLog(logRoot, db)).not.toThrow();

      // The good data survives...
      expect(getSpace('live')).toBeTruthy();
      expect(db.prepare('SELECT id FROM space_events').all()).toEqual([{ id: 'e1' }]);
      // ...and the unreachable rows are gone rather than left behind.
      expect(db.prepare('SELECT COUNT(*) c FROM canvas_agents').get()).toEqual({ c: 0 });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('orphaned space_events'));

      warnSpy.mockRestore();
    });

    it('leaves foreign key enforcement on after replay', () => {
      db.pragma('foreign_keys = ON');
      fs.writeFileSync(logPath, JSON.stringify({
        ts: '2024-01-01T00:00:00.000Z',
        op: 'space.create',
        data: {
          id: 'k1', description: 'Keeps FKs', body: '', status: 'captured',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }) + '\n', 'utf-8');

      replayLog(logRoot, db);

      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      // The restored constraint still rejects a bad write.
      expect(() =>
        db.prepare(
          `INSERT INTO space_events (id, space_id, event_type, created_at)
           VALUES ('bad', 'nope', 'created', '2024-01-01T00:00:00.000Z')`
        ).run()
      ).toThrow(/FOREIGN KEY/);
    });
  });

  // ── intent_event.log ──────────────────────────────────

  describe('intent_event.log', () => {
    it('inserts an space event into space_events table', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'ie-parent', description: 'Parent', body: '',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'intent_event.log',
          data: {
            id: 'evt1', space_id: 'ie-parent', event_type: 'due_date_set',
            due_at: '2024-03-01', due_at_utc: '2024-03-01T00:00:00Z',
            completed_at: null, recurrence_json: null,
            created_at: '2024-01-02T00:00:00.000Z',
          },
        },
      ]);

      replayLog(logRoot, db);
      const evt = db.prepare('SELECT * FROM space_events WHERE id = ?').get('evt1') as any;
      expect(evt).toBeTruthy();
      expect(evt.space_id).toBe('ie-parent');
      expect(evt.event_type).toBe('due_date_set');
      expect(evt.due_at).toBe('2024-03-01');
      expect(evt.due_at_utc).toBe('2024-03-01T00:00:00Z');
    });
  });

  // ── canvas_agent events ───────────────────────────────

  describe('canvas_agent.created', () => {
    it('inserts a canvas agent into the database', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'ca-parent', description: 'Parent', body: '',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'canvas_agent.created',
          data: {
            id: 'ca1', space_id: 'ca-parent', selected_text: 'Fix the bug',
            session_id: 'sess-1', pid: 12345, status: 'running',
            created_at: '2024-01-02T00:00:00.000Z',
            updated_at: '2024-01-02T00:00:00.000Z',
          },
        },
      ]);

      replayLog(logRoot, db);
      const agent = db.prepare('SELECT * FROM canvas_agents WHERE id = ?').get('ca1') as any;
      expect(agent).toBeTruthy();
      expect(agent.space_id).toBe('ca-parent');
      expect(agent.selected_text).toBe('Fix the bug');
      expect(agent.session_id).toBe('sess-1');
      expect(agent.pid).toBe(12345);
      expect(agent.status).toBe('running');
    });

    it('inserts without pid (null)', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'ca-parent2', description: 'Parent', body: '',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'canvas_agent.created',
          data: {
            id: 'ca2', space_id: 'ca-parent2', selected_text: 'Some text',
            session_id: 'sess-2', status: 'running',
            created_at: '2024-01-02T00:00:00.000Z',
            updated_at: '2024-01-02T00:00:00.000Z',
          },
        },
      ]);

      replayLog(logRoot, db);
      const agent = db.prepare('SELECT * FROM canvas_agents WHERE id = ?').get('ca2') as any;
      expect(agent).toBeTruthy();
      expect(agent.pid).toBeNull();
    });
  });

  describe('canvas_agent.updated', () => {
    function seedCanvasAgent(): void {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'cau-parent', description: 'Parent', body: '',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'canvas_agent.created',
          data: {
            id: 'cau1', space_id: 'cau-parent', selected_text: 'Text',
            session_id: 'sess-x', pid: null, status: 'running',
            created_at: '2024-01-02T00:00:00.000Z',
            updated_at: '2024-01-02T00:00:00.000Z',
          },
        },
      ]);
    }

    it('updates status and updated_at without pid', () => {
      seedCanvasAgent();
      // Append the update line
      const lines = fs.readFileSync(logPath, 'utf-8');
      const updateLine = JSON.stringify({
        ts: '2024-01-03T00:00:00.000Z',
        op: 'canvas_agent.updated',
        data: { id: 'cau1', status: 'completed', updated_at: '2024-01-03T00:00:00.000Z' },
      });
      fs.writeFileSync(logPath, lines + updateLine + '\n', 'utf-8');

      replayLog(logRoot, db);
      const agent = db.prepare('SELECT * FROM canvas_agents WHERE id = ?').get('cau1') as any;
      expect(agent.status).toBe('completed');
      expect(agent.updated_at).toBe('2024-01-03T00:00:00.000Z');
      expect(agent.pid).toBeNull();
    });

    it('updates status, pid, and updated_at when pid is provided', () => {
      seedCanvasAgent();
      const lines = fs.readFileSync(logPath, 'utf-8');
      const updateLine = JSON.stringify({
        ts: '2024-01-03T00:00:00.000Z',
        op: 'canvas_agent.updated',
        data: {
          id: 'cau1', status: 'running', pid: 9999,
          updated_at: '2024-01-03T00:00:00.000Z',
        },
      });
      fs.writeFileSync(logPath, lines + updateLine + '\n', 'utf-8');

      replayLog(logRoot, db);
      const agent = db.prepare('SELECT * FROM canvas_agents WHERE id = ?').get('cau1') as any;
      expect(agent.status).toBe('running');
      expect(agent.pid).toBe(9999);
    });
  });

  // ── agent_session events ──────────────────────────────

  describe('agent_session.created', () => {
    it('inserts an agent session into the database', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_session.created',
        data: {
          id: 'as1', session_id: 'sid-1', space_id: 'some-space',
          prompt: 'Fix all bugs', status: 'running',
          summary: 'Fixing bugs', working_dir: '/home/user/project',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('as1') as any;
      expect(sess).toBeTruthy();
      expect(sess.session_id).toBe('sid-1');
      expect(sess.space_id).toBe('some-space');
      expect(sess.prompt).toBe('Fix all bugs');
      expect(sess.status).toBe('running');
      expect(sess.summary).toBe('Fixing bugs');
      expect(sess.working_dir).toBe('/home/user/project');
    });

    it('defaults summary to empty string and working_dir to null', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_session.created',
        data: {
          id: 'as2', session_id: 'sid-2', prompt: 'Run tests', status: 'running',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('as2') as any;
      expect(sess.summary).toBe('');
      expect(sess.working_dir).toBeNull();
      expect(sess.space_id).toBeNull();
    });

    it('defaults run_location to "local" when missing on the event (back-compat)', () => {
      // Legacy events written before the run_location field existed must
      // still replay cleanly and default to a local session.  This protects
      // existing event logs from being broken by the schema addition.
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_session.created',
        data: {
          id: 'as3', session_id: 'sid-3', prompt: 'Old event', status: 'running',
          summary: '', working_dir: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('as3') as any;
      expect(sess.run_location).toBe('local');
      expect(sess.cca_job_id).toBeNull();
      expect(sess.cca_repository).toBeNull();
      expect(sess.cca_effective_repository).toBeNull();
      expect(sess.cca_fallback_json).toBeNull();
      expect(sess.cca_result_json).toBeNull();
    });

    it('replays CCA recovery metadata and subsequent result updates', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'agent_session.created',
          data: {
            id: 'cca1', session_id: 'sid-cca', prompt: 'Cloud event', status: 'running',
            source: 'cca', run_location: 'cloud', cca_job_id: 'job-1',
            cca_repository: 'upstream/repo', cca_effective_repository: 'fork/repo',
            cca_fallback_json: '{"reason":"sso_blocked"}',
            cca_result_json: '{"status":"queued"}',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-01T00:01:00.000Z',
          op: 'agent_session.cca_result',
          data: {
            id: 'cca1',
            cca_result_json: '{"status":"completed"}',
            updated_at: '2024-01-01T00:01:00.000Z',
          },
        },
      ]);

      replayLog(logRoot, db);
      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('cca1') as any;
      expect(sess.cca_job_id).toBe('job-1');
      expect(sess.cca_repository).toBe('upstream/repo');
      expect(sess.cca_effective_repository).toBe('fork/repo');
      expect(sess.cca_result_json).toBe('{"status":"completed"}');
    });

    it('persists run_location="cloud" when present on the event', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_session.created',
        data: {
          id: 'as4', session_id: 'sid-4', prompt: 'Cloud event', status: 'running',
          summary: '', working_dir: '/ws',
          run_location: 'cloud',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('as4') as any;
      expect(sess.run_location).toBe('cloud');
    });

    it('persists comment_thread_id and quoted_text when present on the event', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_session.created',
        data: {
          id: 'as5', session_id: 'sid-5', prompt: 'Comment event', status: 'running',
          summary: '', working_dir: '/ws',
          persona_handle: 'reviewer',
          quoted_text: 'the quick brown fox',
          comment_thread_id: 'c-thread-1',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('as5') as any;
      expect(sess.quoted_text).toBe('the quick brown fox');
      expect(sess.comment_thread_id).toBe('c-thread-1');
    });

    it('defaults comment_thread_id to null when missing (back-compat)', () => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_session.created',
        data: {
          id: 'as6', session_id: 'sid-6', prompt: 'No thread', status: 'running',
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);

      replayLog(logRoot, db);
      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('as6') as any;
      expect(sess.comment_thread_id).toBeNull();
    });

    it('defaults yolo_mode to 0 when missing and persists 1 when set on the event', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'agent_session.created',
          data: {
            id: 'as-yolo-off', session_id: 'sid-yo', prompt: 'No yolo', status: 'running',
            created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'agent_session.created',
          data: {
            id: 'as-yolo-on', session_id: 'sid-yn', prompt: 'Yolo on', status: 'running',
            yolo_mode: true,
            created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
      ]);

      replayLog(logRoot, db);
      const off = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('as-yolo-off') as any;
      const on = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('as-yolo-on') as any;
      expect(off.yolo_mode).toBe(0);
      expect(on.yolo_mode).toBe(1);
    });
  });

  describe('agent_session.yolo', () => {
    beforeEach(() => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_session.created',
        data: {
          id: 'asy1', session_id: 'sid-y', prompt: 'Toggle yolo', status: 'running',
          created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);
      replayLog(logRoot, db);
    });

    it('flips yolo_mode on and back off across replay', () => {
      const base = fs.readFileSync(logPath, 'utf-8');
      fs.writeFileSync(logPath, base + JSON.stringify({
        ts: '2024-01-02T00:00:00.000Z',
        op: 'agent_session.yolo',
        data: { id: 'asy1', yolo_mode: true, updated_at: '2024-01-02T00:00:00.000Z' },
      }) + '\n', 'utf-8');

      db.exec('DELETE FROM agent_sessions');
      replayLog(logRoot, db);
      let sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('asy1') as any;
      expect(sess.yolo_mode).toBe(1);

      const withOn = fs.readFileSync(logPath, 'utf-8');
      fs.writeFileSync(logPath, withOn + JSON.stringify({
        ts: '2024-01-03T00:00:00.000Z',
        op: 'agent_session.yolo',
        data: { id: 'asy1', yolo_mode: false, updated_at: '2024-01-03T00:00:00.000Z' },
      }) + '\n', 'utf-8');

      db.exec('DELETE FROM agent_sessions');
      replayLog(logRoot, db);
      sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('asy1') as any;
      expect(sess.yolo_mode).toBe(0);
    });
  });

  describe('agent_session.updated', () => {
    beforeEach(() => {
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_session.created',
        data: {
          id: 'asu1', session_id: 'sid-u', prompt: 'Original', status: 'running',
          summary: '', working_dir: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      }]);
      replayLog(logRoot, db);
    });

    it('updates status without summary', () => {
      const lines = fs.readFileSync(logPath, 'utf-8');
      fs.writeFileSync(logPath, lines + JSON.stringify({
        ts: '2024-01-02T00:00:00.000Z',
        op: 'agent_session.updated',
        data: { id: 'asu1', status: 'completed', updated_at: '2024-01-02T00:00:00.000Z' },
      }) + '\n', 'utf-8');

      // Replay from scratch
      db.exec('DELETE FROM agent_sessions');
      replayLog(logRoot, db);

      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('asu1') as any;
      expect(sess.status).toBe('completed');
      expect(sess.summary).toBe('');
    });

    it('updates status and summary when summary is provided', () => {
      const lines = fs.readFileSync(logPath, 'utf-8');
      fs.writeFileSync(logPath, lines + JSON.stringify({
        ts: '2024-01-02T00:00:00.000Z',
        op: 'agent_session.updated',
        data: {
          id: 'asu1', status: 'completed',
          summary: 'All tests passed', updated_at: '2024-01-02T00:00:00.000Z',
        },
      }) + '\n', 'utf-8');

      db.exec('DELETE FROM agent_sessions');
      replayLog(logRoot, db);

      const sess = db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get('asu1') as any;
      expect(sess.status).toBe('completed');
      expect(sess.summary).toBe('All tests passed');
    });
  });

  describe('agent_chat.appended', () => {
    it('inserts persisted chat events on replay', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'agent_chat.appended',
          data: {
            agent_id: 'chat-agent',
            seq: 1,
            event_id: 'evt-1',
            type: 'user.message',
            timestamp: '2024-01-01T00:00:00.000Z',
            payload: JSON.stringify({ content: 'hello' }),
          },
        },
        {
          ts: '2024-01-01T00:00:01.000Z',
          op: 'agent_chat.appended',
          data: {
            agent_id: 'chat-agent',
            seq: 2,
            event_id: 'evt-2',
            type: 'assistant.message',
            timestamp: '2024-01-01T00:00:01.000Z',
            payload: JSON.stringify({ content: 'hi back' }),
          },
        },
      ]);

      replayLog(logRoot, db);

      const rows = db.prepare(
        'SELECT seq, event_id, type, payload FROM agent_chat_events WHERE agent_id = ? ORDER BY seq ASC'
      ).all('chat-agent') as any[];
      expect(rows).toHaveLength(2);
      expect(rows[0].type).toBe('user.message');
      expect(JSON.parse(rows[0].payload).content).toBe('hello');
      expect(rows[1].type).toBe('assistant.message');
      expect(JSON.parse(rows[1].payload).content).toBe('hi back');
    });

    it('is idempotent across repeated replays (UNIQUE(agent_id, seq) + INSERT OR IGNORE)', () => {
      // Replaying the same log twice (e.g. after a crash + restart)
      // must not double-insert chat events.
      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'agent_chat.appended',
        data: {
          agent_id: 'dup-agent',
          seq: 1,
          event_id: 'evt-1',
          type: 'user.message',
          timestamp: '2024-01-01T00:00:00.000Z',
          payload: '{}',
        },
      }]);

      replayLog(logRoot, db);
      replayLog(logRoot, db);

      const rows = db.prepare(
        'SELECT COUNT(*) AS n FROM agent_chat_events WHERE agent_id = ?'
      ).get('dup-agent') as any;
      expect(rows.n).toBe(1);
    });
  });

  // ── Unknown ops ───────────────────────────────────────

  describe('unknown event op', () => {
    it('logs a warning but does not crash', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      writeLog([{
        ts: '2024-01-01T00:00:00.000Z',
        op: 'totally.unknown.operation',
        data: { id: 'x' },
      }]);

      expect(() => replayLog(logRoot, db)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown event op: totally.unknown.operation')
      );

      warnSpy.mockRestore();
    });
  });

  // ── Idempotent replay ─────────────────────────────────

  describe('idempotent replay', () => {
    it('replaying the same log twice produces the same state (INSERT OR REPLACE)', () => {
      writeLog([
        {
          ts: '2024-01-01T00:00:00.000Z',
          op: 'space.create',
          data: {
            id: 'idem1', description: 'Idempotent', body: 'Test body',
            status: 'captured',
            created_at: '2024-01-01T00:00:00.000Z',
            updated_at: '2024-01-01T00:00:00.000Z',
          },
        },
        {
          ts: '2024-01-02T00:00:00.000Z',
          op: 'space.update',
          data: { id: 'idem1', fields: { description: 'Updated idem' } },
        },
      ]);

      replayLog(logRoot, db);
      const first = getSpace('idem1');

      // Replay again on same DB
      replayLog(logRoot, db);
      const second = getSpace('idem1');

      expect(second).toEqual(first);
      expect(allSpaces()).toHaveLength(1);
    });
  });
});
