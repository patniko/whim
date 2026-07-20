import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock electron (required by config.ts dependency chain)
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/electron-path' },
}));

// Mock eventlog — spy on appendEvent, no-op replayLog
vi.mock('./eventlog', () => ({
  appendEvent: vi.fn(),
  replayLog: vi.fn(),
}));

// Mock workspace — readCanvas returns configurable content
vi.mock('./workspace', () => ({
  readCanvas: vi.fn(() => ''),
  slugify: vi.fn((text: string, spaceId: string) => {
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'space';
    return `${slug}-${spaceId.replace(/-/g, '').slice(0, 4)}`;
  }),
}));

import {
  initDatabase,
  getDatabase,
  isInitialized,
  closeDatabase,
  createSpace,
  getSpace,
  listSpaces,
  updateSpace,
  updateSpaceCAS,
  deleteSpace,
  assignSpaceFolder,
  searchSpaces,
  syncCanvasContent,
  updateCanvasContent,
  mergeSessionIds,
  logSpaceEvent,
  listSpaceEvents,
  setSpaceSessionId,
  createCanvasAgent,
  updateCanvasAgentStatus,
  listCanvasAgents,
  listAllRunningAgents,
  createAgentSession,
  updateAgentSessionStatus,
  updateAgentSessionCcaResult,
  getAgentSession,
  listAgentSessions,
  deleteAgentSession,
  appendAgentChatEvent,
  listAgentChatEvents,
  clearAgentChatEvents,
} from './database';
import { appendEvent } from './eventlog';
import { readCanvas } from './workspace';
import type { CanvasAgent, AgentSession, Attachment } from '../shared/types';

let testDir: string;

function freshDb() {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-db-test-'));
  const dbPath = path.join(testDir, 'test.db');
  // Rotated event-log root, not a single file.
  const logRoot = path.join(testDir, 'events');
  initDatabase(dbPath, logRoot);
}

beforeEach(() => {
  vi.clearAllMocks();
  freshDb();
});

afterEach(() => {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ── Helpers ───────────────────────────────────────────────

function makeIntent(body = 'Test space body') {
  return createSpace({ body });
}

function makeCanvasAgent(spaceId: string, overrides: Partial<CanvasAgent> = {}): CanvasAgent {
  const now = new Date().toISOString();
  return {
    id: `agent-${Date.now()}`,
    space_id: spaceId,
    selected_text: 'some text',
    session_id: 'sess-1',
    pid: null,
    status: 'running',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  const now = new Date().toISOString();
  return {
    id: `as-${Date.now()}`,
    session_id: 'sess-1',
    space_id: null,
    prompt: 'Do something',
    status: 'running',
    summary: '',
    working_dir: null,
    source: 'sdk',
    persona_handle: null,
    quoted_text: null,
    run_location: 'local',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────

describe('database', () => {
  describe('initDatabase', () => {
    it('initializes the database and calls replayLog', () => {
      expect(isInitialized()).toBe(true);
      expect(getDatabase()).toBeDefined();
    });
  });

  // ── Space CRUD lifecycle ──────────────────────────────

  describe('Space CRUD lifecycle', () => {
    it('creates, gets, lists, updates, and deletes an space', () => {
      const space = makeIntent('Buy groceries');
      expect(space.id).toBeDefined();
      expect(space.description).toBe('Buy groceries');
      expect(space.body).toBe('# Buy groceries');
      expect(space.raw_text).toBe('Buy groceries');
      expect(space.status).toBe('captured');
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'space.create',
        expect.objectContaining({ id: space.id }),
      );

      // getSpace
      const fetched = getSpace(space.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(space.id);

      // listSpaces
      const list = listSpaces();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(space.id);

      // updateSpace
      const updated = updateSpace(space.id, { description: 'Updated title', status: 'in_progress' });
      expect(updated).not.toBeNull();
      expect(updated!.description).toBe('Updated title');
      expect(updated!.status).toBe('in_progress');
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'space.update',
        expect.objectContaining({ id: space.id }),
      );

      // deleteSpace
      const deleted = deleteSpace(space.id);
      expect(deleted).toBe(true);
      expect(getSpace(space.id)).toBeNull();
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'space.delete',
        expect.objectContaining({ id: space.id }),
      );
    });

    it('deleteSpace returns false for non-existent id', () => {
      expect(deleteSpace('nonexistent-id')).toBe(false);
    });

    it('getSpace returns null for unknown id', () => {
      expect(getSpace('nonexistent-id')).toBeNull();
    });
  });

  // ── Placeholder title ──────────────────────────────────

  describe('placeholder title', () => {
    it('extracts the first line as the description', () => {
      const space = createSpace({ body: 'First line\nSecond line\nThird line' });
      expect(space.description).toBe('First line');
      expect(space.body).toBe('# First line\nSecond line\nThird line');
    });

    it('truncates long first lines to 80 chars with ellipsis', () => {
      const longLine = 'A'.repeat(100);
      const space = createSpace({ body: longLine });
      expect(space.description).toBe('A'.repeat(79) + '…');
      expect(space.description.length).toBe(80);
    });

    it('preserves short first lines without truncation', () => {
      const space = createSpace({ body: 'Short title' });
      expect(space.description).toBe('Short title');
    });

    it('uses exactly 80-char first line without truncation', () => {
      const line80 = 'B'.repeat(80);
      const space = createSpace({ body: line80 });
      expect(space.description).toBe(line80);
    });
  });

  // ── Attachments round-trip ─────────────────────────────

  describe('attachments round-trip', () => {
    it('serializes and deserializes attachments', () => {
      const space = makeIntent();
      const attachments: Attachment[] = [
        { type: 'url', name: 'Link', url: 'https://example.com' },
        { type: 'file', name: 'Doc', url: 'file://doc.pdf', relativePath: 'attachments/doc.pdf' },
      ];
      const updated = updateSpace(space.id, { attachments });
      expect(updated!.attachments).toEqual(attachments);

      // Re-fetch to confirm persistence
      const fetched = getSpace(space.id);
      expect(fetched!.attachments).toEqual(attachments);
    });

    it('returns empty array for null/empty attachments', () => {
      const space = makeIntent();
      expect(space.attachments).toEqual([]);

      // Manually set to null via raw DB
      getDatabase().prepare('UPDATE spaces SET attachments = NULL WHERE id = ?').run(space.id);
      const fetched = getSpace(space.id);
      expect(fetched!.attachments).toEqual([]);

      // Manually set to invalid JSON
      getDatabase().prepare("UPDATE spaces SET attachments = 'not-json' WHERE id = ?").run(space.id);
      const fetched2 = getSpace(space.id);
      expect(fetched2!.attachments).toEqual([]);
    });
  });

  // ── updateSpaceCAS ────────────────────────────────────

  describe('updateSpaceCAS', () => {
    it('succeeds with matching version', () => {
      const space = makeIntent();
      const result = updateSpaceCAS(space.id, space.updated_at, { description: 'CAS updated' });
      expect(result).not.toBeNull();
      expect(result!.description).toBe('CAS updated');
    });

    it('returns null with stale version', () => {
      const space = makeIntent();
      const result = updateSpaceCAS(space.id, 'stale-version-string', { description: 'Should fail' });
      expect(result).toBeNull();
      // Verify original is untouched
      const fetched = getSpace(space.id);
      expect(fetched!.description).toBe(space.description);
    });

    it('returns null for non-existent space', () => {
      const result = updateSpaceCAS('nonexistent', '2024-01-01T00:00:00.000Z', { description: 'nope' });
      expect(result).toBeNull();
    });
  });

  // ── listSpaces ordering ───────────────────────────────

  describe('listSpaces ordering', () => {
    it('orders: done last, in_progress first, due dates ascending, then updated_at descending', () => {
      // Create spaces with controlled timestamps
      const a = createSpace({ body: 'A - in_progress' });
      const b = createSpace({ body: 'B - captured with due' });
      const c = createSpace({ body: 'C - captured no due' });
      const d = createSpace({ body: 'D - done' });

      // Set statuses and due dates via raw DB for precise control
      const db = getDatabase();
      db.prepare("UPDATE spaces SET status = 'in_progress', updated_at = '2024-06-01T00:00:00Z' WHERE id = ?").run(a.id);
      db.prepare("UPDATE spaces SET status = 'captured', due_at_utc = '2024-07-01T00:00:00Z', updated_at = '2024-05-01T00:00:00Z' WHERE id = ?").run(b.id);
      db.prepare("UPDATE spaces SET status = 'captured', updated_at = '2024-05-02T00:00:00Z' WHERE id = ?").run(c.id);
      db.prepare("UPDATE spaces SET status = 'done', updated_at = '2024-06-15T00:00:00Z' WHERE id = ?").run(d.id);

      const list = listSpaces();
      const ids = list.map(i => i.id);

      // in_progress first, then captured with due, then captured without due, then done
      expect(ids[0]).toBe(a.id); // in_progress
      expect(ids[1]).toBe(b.id); // captured with due_at_utc
      expect(ids[2]).toBe(c.id); // captured, no due, but more recent
      expect(ids[3]).toBe(d.id); // done last
    });
  });

  // ── searchSpaces ──────────────────────────────────────

  describe('searchSpaces', () => {
    it('matches in description', () => {
      const space = makeIntent('search-term-unique');
      const results = searchSpaces('search-term-unique');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(space.id);
    });

    it('matches in body', () => {
      const space = createSpace({ body: 'Title\nBody has findme123 keyword' });
      const results = searchSpaces('findme123');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(space.id);
    });

    it('matches in canvas_content', () => {
      const space = makeIntent();
      updateCanvasContent(space.id, 'canvas-unique-content-xyz');
      const results = searchSpaces('canvas-unique-content-xyz');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(space.id);
    });

    it('returns no results for non-matching query', () => {
      makeIntent('Totally unrelated');
      const results = searchSpaces('zzz-nonexistent-zzz');
      expect(results).toHaveLength(0);
    });
  });

  // ── assignSpaceFolder ─────────────────────────────────

  describe('assignSpaceFolder', () => {
    it('sets folder and logs event', () => {
      const space = makeIntent();
      assignSpaceFolder(space.id, 'my-folder-abc1');

      const fetched = getSpace(space.id);
      expect(fetched!.folder).toBe('my-folder-abc1');
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'space.assign_folder',
        expect.objectContaining({ id: space.id, folder: 'my-folder-abc1' }),
      );
    });
  });

  // ── syncCanvasContent ──────────────────────────────────

  describe('syncCanvasContent', () => {
    it('populates canvas_content from disk for spaces with folders', () => {
      const space = makeIntent();
      assignSpaceFolder(space.id, 'test-folder');

      vi.mocked(readCanvas).mockReturnValue('# Canvas Content\nHello world');
      syncCanvasContent('/fake/workspace');

      // canvas_content isn't in the Space type — verify via raw DB
      const row = getDatabase().prepare('SELECT canvas_content FROM spaces WHERE id = ?').get(space.id) as any;
      expect(row.canvas_content).toBe('# Canvas Content\nHello world');
      expect(getSpace(space.id)!.description).toBe('Canvas Content');
      expect(readCanvas).toHaveBeenCalledWith('/fake/workspace', 'test-folder');
    });

    it('skips spaces without folders', () => {
      const space = makeIntent();
      // Simulate a legacy space that never had a folder assigned.
      getDatabase().prepare('UPDATE spaces SET folder = NULL WHERE id = ?').run(space.id);
      syncCanvasContent('/fake/workspace');
      expect(readCanvas).not.toHaveBeenCalled();
    });

    it('handles readCanvas errors gracefully', () => {
      const space = makeIntent();
      assignSpaceFolder(space.id, 'bad-folder');
      vi.mocked(readCanvas).mockImplementation(() => { throw new Error('ENOENT'); });

      // Should not throw
      expect(() => syncCanvasContent('/fake/workspace')).not.toThrow();
    });
  });

  // ── updateCanvasContent ────────────────────────────────

  describe('updateCanvasContent', () => {
    it('updates the cached canvas content for an space', () => {
      const space = makeIntent();
      const result = updateCanvasContent(space.id, '# New canvas content\nBody');

      const db = getDatabase();
      const row = db.prepare('SELECT canvas_content, description FROM spaces WHERE id = ?').get(space.id) as any;
      expect(row.canvas_content).toBe('# New canvas content\nBody');
      expect(row.description).toBe('New canvas content');
      expect(result).toEqual({ title: 'New canvas content', titleChanged: true });
    });
  });

  // ── Canvas Agents ──────────────────────────────────────

  describe('Canvas Agents', () => {
    it('creates and lists canvas agents for an space', () => {
      const space = makeIntent();
      const agent = makeCanvasAgent(space.id, { id: 'ca-1', session_id: 'sess-100' });
      createCanvasAgent(agent);

      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'canvas_agent.created',
        expect.objectContaining({ id: 'ca-1' }),
      );

      const agents = listCanvasAgents(space.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe('ca-1');
      expect(agents[0].session_id).toBe('sess-100');
    });

    it('updateCanvasAgentStatus updates status', () => {
      const space = makeIntent();
      const agent = makeCanvasAgent(space.id, { id: 'ca-2' });
      createCanvasAgent(agent);

      updateCanvasAgentStatus('ca-2', 'completed');

      const agents = listCanvasAgents(space.id);
      expect(agents[0].status).toBe('completed');
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'canvas_agent.updated',
        expect.objectContaining({ id: 'ca-2', status: 'completed' }),
      );
    });

    it('updateCanvasAgentStatus updates pid when provided', () => {
      const space = makeIntent();
      const agent = makeCanvasAgent(space.id, { id: 'ca-3' });
      createCanvasAgent(agent);

      updateCanvasAgentStatus('ca-3', 'running', 12345);

      const agents = listCanvasAgents(space.id);
      expect(agents[0].pid).toBe(12345);
    });

    it('listAllRunningAgents returns only running agents', () => {
      const space = makeIntent();
      const running = makeCanvasAgent(space.id, { id: 'ca-running', status: 'running' });
      const completed = makeCanvasAgent(space.id, { id: 'ca-done', status: 'completed' });
      createCanvasAgent(running);
      createCanvasAgent(completed);

      const result = listAllRunningAgents();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('ca-running');
    });
  });

  // ── Agent Sessions ─────────────────────────────────────

  describe('Agent Sessions', () => {
    it('creates, gets, and lists agent sessions', () => {
      const session = makeAgentSession({ id: 'as-1', session_id: 'sid-1', prompt: 'Fix bugs' });
      createAgentSession(session);

      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'agent_session.created',
        expect.objectContaining({ id: 'as-1' }),
      );

      const fetched = getAgentSession('as-1');
      expect(fetched).not.toBeNull();
      expect(fetched!.prompt).toBe('Fix bugs');
      expect(fetched!.status).toBe('running');

      const list = listAgentSessions();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('as-1');
    });

    it('getAgentSession returns null for unknown id', () => {
      expect(getAgentSession('nonexistent')).toBeNull();
    });

    it('persists and reads back comment_thread_id for comment-thread agents', () => {
      const session = makeAgentSession({
        id: 'as-thread',
        session_id: 'sid-thread',
        space_id: 'space-1',
        persona_handle: 'reviewer',
        quoted_text: 'the quick brown fox',
        comment_thread_id: 'c-thread-42',
      });
      createAgentSession(session);

      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'agent_session.created',
        expect.objectContaining({ id: 'as-thread', comment_thread_id: 'c-thread-42' }),
      );

      const fetched = getAgentSession('as-thread');
      expect(fetched!.comment_thread_id).toBe('c-thread-42');
      expect(fetched!.quoted_text).toBe('the quick brown fox');

      const listed = listAgentSessions().find(s => s.id === 'as-thread');
      expect(listed!.comment_thread_id).toBe('c-thread-42');
    });

    it('defaults comment_thread_id to null for non-comment agents', () => {
      createAgentSession(makeAgentSession({ id: 'as-nothread', session_id: 'sid-nothread' }));
      expect(getAgentSession('as-nothread')!.comment_thread_id).toBeNull();
    });

    it('persists CCA recovery metadata and latest result', () => {
      createAgentSession(makeAgentSession({
        id: 'cca-session',
        source: 'cca',
        run_location: 'cloud',
        cca_job_id: 'job-42',
        cca_repository: 'upstream/repo',
        cca_effective_repository: 'fork/repo',
        cca_fallback_json: '{"reason":"sso_blocked"}',
        cca_result_json: '{"status":"queued"}',
      }));

      updateAgentSessionCcaResult('cca-session', '{"status":"completed"}');
      const fetched = getAgentSession('cca-session')!;
      expect(fetched.cca_job_id).toBe('job-42');
      expect(fetched.cca_repository).toBe('upstream/repo');
      expect(fetched.cca_effective_repository).toBe('fork/repo');
      expect(fetched.cca_fallback_json).toContain('sso_blocked');
      expect(fetched.cca_result_json).toBe('{"status":"completed"}');
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'agent_session.cca_result',
        expect.objectContaining({ id: 'cca-session', cca_result_json: '{"status":"completed"}' }),
      );
    });

    it('updateAgentSessionStatus updates status without summary', () => {
      const session = makeAgentSession({ id: 'as-2' });
      createAgentSession(session);

      updateAgentSessionStatus('as-2', 'completed');

      const fetched = getAgentSession('as-2');
      expect(fetched!.status).toBe('completed');
      expect(fetched!.summary).toBe(''); // unchanged
    });

    it('updateAgentSessionStatus updates status with summary', () => {
      const session = makeAgentSession({ id: 'as-3' });
      createAgentSession(session);

      updateAgentSessionStatus('as-3', 'completed', 'All bugs fixed');

      const fetched = getAgentSession('as-3');
      expect(fetched!.status).toBe('completed');
      expect(fetched!.summary).toBe('All bugs fixed');
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'agent_session.updated',
        expect.objectContaining({ id: 'as-3', status: 'completed', summary: 'All bugs fixed' }),
      );
    });

    it('listAgentSessions returns sessions in descending created_at order', () => {
      const s1 = makeAgentSession({ id: 'as-old', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' });
      const s2 = makeAgentSession({ id: 'as-new', created_at: '2024-06-01T00:00:00Z', updated_at: '2024-06-01T00:00:00Z' });
      createAgentSession(s1);
      createAgentSession(s2);

      const list = listAgentSessions();
      expect(list[0].id).toBe('as-new');
      expect(list[1].id).toBe('as-old');
    });

    it('deleteAgentSession removes the session from the database', () => {
      const session = makeAgentSession({ id: 'as-del', session_id: 'sid-del', prompt: 'Delete me' });
      createAgentSession(session);
      expect(getAgentSession('as-del')).not.toBeNull();

      deleteAgentSession('as-del');
      expect(getAgentSession('as-del')).toBeNull();

      // Verify event was logged
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'agent_session.deleted',
        { id: 'as-del' },
      );
    });

    it('deleteAgentSession is idempotent for nonexistent id', () => {
      // Should not throw
      deleteAgentSession('nonexistent-id');
      expect(getAgentSession('nonexistent-id')).toBeNull();
    });

    it('deleteAgentSession only removes the targeted session', () => {
      const s1 = makeAgentSession({ id: 'as-keep', session_id: 'sid-keep' });
      const s2 = makeAgentSession({ id: 'as-remove', session_id: 'sid-remove' });
      createAgentSession(s1);
      createAgentSession(s2);

      deleteAgentSession('as-remove');
      expect(getAgentSession('as-keep')).not.toBeNull();
      expect(getAgentSession('as-remove')).toBeNull();
      expect(listAgentSessions()).toHaveLength(1);
    });
  });

  // ── Agent Chat Events ──────────────────────────────────

  describe('Agent Chat Events', () => {
    it('appends events with auto-incrementing seq per agent', () => {
      const seq1 = appendAgentChatEvent('agent-1', {
        event_id: 'e-1', type: 'user.message',
        timestamp: '2024-01-01T00:00:00Z',
        payload: JSON.stringify({ content: 'hi' }),
      });
      const seq2 = appendAgentChatEvent('agent-1', {
        event_id: 'e-2', type: 'assistant.message',
        timestamp: '2024-01-01T00:00:01Z',
        payload: JSON.stringify({ content: 'hi back' }),
      });
      // Second agent starts its own sequence at 1, independent of agent-1.
      const seq3 = appendAgentChatEvent('agent-2', {
        event_id: 'e-3', type: 'user.message',
        timestamp: '2024-01-01T00:00:02Z',
        payload: '{}',
      });
      expect(seq1).toBe(1);
      expect(seq2).toBe(2);
      expect(seq3).toBe(1);
    });

    it('is idempotent on (agent_id, event_id) — same event_id is a no-op', () => {
      // The SDK replays its own event log on session resume, so the
      // host may observe the same event twice.  Persistence must dedup.
      appendAgentChatEvent('agent-dedup', {
        event_id: 'evt-X', type: 'assistant.message',
        timestamp: '2024-01-01T00:00:00Z', payload: '{}',
      });
      const seq2 = appendAgentChatEvent('agent-dedup', {
        event_id: 'evt-X', type: 'assistant.message',
        timestamp: '2024-01-01T00:00:00Z', payload: '{}',
      });

      const events = listAgentChatEvents('agent-dedup');
      expect(events).toHaveLength(1);
      // The second call should return the existing seq, not a new one.
      expect(seq2).toBe(1);
    });

    it('listAgentChatEvents returns events in seq order', () => {
      appendAgentChatEvent('agent-order', {
        event_id: null, type: 'user.message',
        timestamp: '2024-01-01T00:00:00Z', payload: JSON.stringify({ content: 'first' }),
      });
      appendAgentChatEvent('agent-order', {
        event_id: null, type: 'assistant.message',
        timestamp: '2024-01-01T00:00:01Z', payload: JSON.stringify({ content: 'second' }),
      });

      const events = listAgentChatEvents('agent-order');
      expect(events).toHaveLength(2);
      expect(events[0].seq).toBe(1);
      expect(events[0].type).toBe('user.message');
      expect(events[1].seq).toBe(2);
      expect(events[1].type).toBe('assistant.message');
    });

    it('clearAgentChatEvents removes only the specified agents events', () => {
      appendAgentChatEvent('agent-a', { event_id: null, type: 'user.message', timestamp: 't', payload: '{}' });
      appendAgentChatEvent('agent-b', { event_id: null, type: 'user.message', timestamp: 't', payload: '{}' });

      clearAgentChatEvents('agent-a');
      expect(listAgentChatEvents('agent-a')).toHaveLength(0);
      expect(listAgentChatEvents('agent-b')).toHaveLength(1);
    });

    it('deleteAgentSession cascades chat events for that agent', () => {
      const sess = makeAgentSession({ id: 'cascade-agent', session_id: 'sid-cascade' });
      createAgentSession(sess);
      appendAgentChatEvent('cascade-agent', { event_id: null, type: 'user.message', timestamp: 't', payload: '{}' });
      appendAgentChatEvent('cascade-agent', { event_id: null, type: 'assistant.message', timestamp: 't', payload: '{}' });
      expect(listAgentChatEvents('cascade-agent')).toHaveLength(2);

      deleteAgentSession('cascade-agent');
      expect(listAgentChatEvents('cascade-agent')).toHaveLength(0);
    });

    it('writes to event log so events replay on DB rebuild', () => {
      appendAgentChatEvent('replay-agent', {
        event_id: 'evt-replay',
        type: 'user.message',
        timestamp: '2024-01-01T00:00:00Z',
        payload: JSON.stringify({ content: 'persist me' }),
      });

      // Verify the event was logged (the eventlog round-trip test in
      // integration.test.ts proves replay correctness end-to-end).
      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'agent_chat.appended',
        expect.objectContaining({
          agent_id: 'replay-agent',
          seq: 1,
          event_id: 'evt-replay',
          type: 'user.message',
        }),
      );
    });
  });

  // ── mergeSessionIds ────────────────────────────────────

  describe('mergeSessionIds', () => {
    it('injects session IDs into existing spaces', () => {
      const intent1 = makeIntent('Space 1');
      const intent2 = makeIntent('Space 2');

      mergeSessionIds({
        [intent1.id]: 'local-session-1',
        [intent2.id]: 'local-session-2',
      });

      expect(getSpace(intent1.id)!.session_id).toBe('local-session-1');
      expect(getSpace(intent2.id)!.session_id).toBe('local-session-2');
    });

    it('ignores non-existent space IDs without error', () => {
      expect(() => mergeSessionIds({ 'nonexistent': 'some-session' })).not.toThrow();
    });
  });

  // ── logSpaceEvent / listSpaceEvents ──────────────────

  describe('logSpaceEvent / listSpaceEvents', () => {
    it('logs events and retrieves them with joins', () => {
      const space = makeIntent('Event test');

      logSpaceEvent(space.id, 'due_at.set', {
        due_at: '2024-12-25',
        due_at_utc: '2024-12-25T00:00:00Z',
      });

      logSpaceEvent(space.id, 'completed', {
        completed_at: '2024-12-20T10:00:00Z',
      });

      expect(appendEvent).toHaveBeenCalledWith(
        expect.any(String),
        'intent_event.log',
        expect.objectContaining({ space_id: space.id, event_type: 'due_at.set' }),
      );

      const events = listSpaceEvents();
      expect(events).toHaveLength(2);
      const types = events.map(e => e.event_type).sort();
      expect(types).toEqual(['completed', 'due_at.set']);
      // Join brings in space data
      expect(events[0].space_description).toBe(space.description);
    });

    it('respects the limit parameter', () => {
      const space = makeIntent();
      logSpaceEvent(space.id, 'event-1');
      logSpaceEvent(space.id, 'event-2');
      logSpaceEvent(space.id, 'event-3');

      const events = listSpaceEvents(2);
      expect(events).toHaveLength(2);
    });

    it('cascades delete — events removed when space is deleted', () => {
      const space = makeIntent();
      logSpaceEvent(space.id, 'some-event');
      deleteSpace(space.id);

      // ON DELETE CASCADE removes associated intent_events
      const events = listSpaceEvents();
      expect(events).toHaveLength(0);
    });
  });

  // ── setSpaceSessionId ─────────────────────────────────

  describe('setSpaceSessionId', () => {
    it('updates session_id directly on an space', () => {
      const space = makeIntent();
      expect(space.session_id).toBeNull();

      setSpaceSessionId(space.id, 'direct-session-id');

      const fetched = getSpace(space.id);
      expect(fetched!.session_id).toBe('direct-session-id');
    });

    it('does not log to event log (per-machine only)', () => {
      const space = makeIntent();
      vi.clearAllMocks();

      setSpaceSessionId(space.id, 'sess-xyz');
      expect(appendEvent).not.toHaveBeenCalled();
    });
  });

  // ── updateSpace field coverage ────────────────────────

  describe('updateSpace field coverage', () => {
    it('updates all supported fields', () => {
      const space = makeIntent();
      const updated = updateSpace(space.id, {
        description: 'New desc',
        body: 'New body',
        client: 'test-client',
        due_at: '2024-12-31',
        due_at_utc: '2024-12-31T00:00:00Z',
        recurrence: '{"freq":"weekly"}',
        completed_at: '2024-12-30T12:00:00Z',
        status: 'done',
        attachments: [{ type: 'url', name: 'Link', url: 'https://example.com' }],
      });

      expect(updated!.description).toBe('New desc');
      expect(updated!.body).toBe('New body');
      expect(updated!.client).toBe('test-client');
      expect(updated!.due_at).toBe('2024-12-31');
      expect(updated!.due_at_utc).toBe('2024-12-31T00:00:00Z');
      expect(updated!.recurrence).toBe('{"freq":"weekly"}');
      expect(updated!.completed_at).toBe('2024-12-30T12:00:00Z');
      expect(updated!.status).toBe('done');
      expect(updated!.attachments).toHaveLength(1);
    });

    it('returns null when updating non-existent space', () => {
      const result = updateSpace('nonexistent', { description: 'nope' });
      // appendEvent is still called (log-first), but getSpace returns null
      expect(result).toBeNull();
    });
  });

  // ── closeDatabase ──────────────────────────────────────

  describe('closeDatabase', () => {
    it('makes isInitialized return false', () => {
      expect(isInitialized()).toBe(true);
      closeDatabase();
      expect(isInitialized()).toBe(false);
    });

    it('is safe to call when no DB is open', () => {
      closeDatabase();
      expect(isInitialized()).toBe(false);
      // Double-close should not throw
      closeDatabase();
      expect(isInitialized()).toBe(false);
    });

    it('allows reinitializing after close', () => {
      closeDatabase();
      expect(isInitialized()).toBe(false);

      freshDb();
      expect(isInitialized()).toBe(true);

      // DB is functional after reinit
      const space = createSpace({ body: 'after reopen' });
      expect(space.id).toBeDefined();
      expect(getSpace(space.id)).not.toBeNull();
    });
  });
});
