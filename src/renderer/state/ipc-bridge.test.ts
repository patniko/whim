import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WhimAPI } from '../ipc-client';
import type { Space, Skill, SpaceCanvasArtifact } from '../../shared/types';
import type { AgentListAllItem, AgentPersona, SpaceEvent } from '../../shared/ipc-contract';
import { toSpaceSummary } from '../../shared/paging';
import { spaceStore } from './space-store';
import { agentStore } from './agent-store';
import { skillStore } from './skill-store';
import { historyStore } from './history-store';
import { personaStore } from './persona-store';
import { canvasArtifactStore } from './canvas-artifact-store';
import {
  installIpcBridge,
  loadSpacesSnapshot,
  loadAgentsSnapshot,
  loadSkillsSnapshot,
  loadHistorySnapshot,
  loadPersonasSnapshot,
  loadCanvasArtifactsSnapshot,
  loadSpaceArtifacts,
  refreshVisibleCollections,
  getRefreshTimings,
  _resetIpcBridgeForTests,
} from './ipc-bridge';

// ── Tiny WhimAPI mock factory ────────────────────────────────────────────
// We only mock the surface the bridge touches. Each `on*` is captured so the
// tests can fire payloads manually.

interface BridgeMock {
  api: WhimAPI;
  fire: {
    agentStatus: (data: unknown) => void;
    agentApproval: (data: unknown) => void;
    agentApprovalResolved: (data: unknown) => void;
    agentCompleted: (data: unknown) => void;
    agentYolo: (data: unknown) => void;
    agentRemote: (data: unknown) => void;
    agentPresenceStarted: (data: unknown) => void;
    agentPresenceEnded: (data: unknown) => void;
    spaceProcessed: (id: string) => void;
    spaceTitleUpdated: (data: { spaceId: string; title: string }) => void;
    recurrenceApplied: (id: string) => void;
    skillsChanged: () => void;
    canvasArtifactPublished: (data: { spaceId: string; artifactId: string; title: string }) => void;
    workspaceChanged: (path: string | null) => void;
  };
  calls: {
    list: ReturnType<typeof vi.fn>;
    getActiveSessions: ReturnType<typeof vi.fn>;
    listAllAgents: ReturnType<typeof vi.fn>;
    listSkills: ReturnType<typeof vi.fn>;
    listEvents: ReturnType<typeof vi.fn>;
    listPersonas: ReturnType<typeof vi.fn>;
    listCanvasArtifacts: ReturnType<typeof vi.fn>;
    listAllCanvasArtifacts: ReturnType<typeof vi.fn>;
  };
}

function makeMock(overrides: Partial<{
  list: unknown[];
  getActiveSessions: string[];
  listAllAgents: unknown[];
  listSkills: unknown[];
  listEvents: unknown[];
  listPersonas: unknown[];
  listCanvasArtifacts: unknown[];
  listAllCanvasArtifacts: unknown[];
}> = {}): BridgeMock {
  const fire = {} as BridgeMock['fire'];

  const calls = {
    list: vi.fn().mockResolvedValue(overrides.list ?? []),
    getActiveSessions: vi.fn().mockResolvedValue(overrides.getActiveSessions ?? []),
    listAllAgents: vi.fn().mockResolvedValue(overrides.listAllAgents ?? []),
    listSkills: vi.fn().mockResolvedValue(overrides.listSkills ?? []),
    listEvents: vi.fn().mockResolvedValue(overrides.listEvents ?? []),
    listPersonas: vi.fn().mockResolvedValue(overrides.listPersonas ?? []),
    listCanvasArtifacts: vi.fn().mockResolvedValue({ artifacts: overrides.listCanvasArtifacts ?? [] }),
    listAllCanvasArtifacts: vi.fn().mockResolvedValue({ artifacts: overrides.listAllCanvasArtifacts ?? [] }),
  };

  const api = {
    list: calls.list,
    listSpacePage: async () => {
      const items = await calls.list();
      return { items, total: items.length, nextCursor: null, counts: {
        open: items.filter((item: Space) => item.status !== 'done').length,
        closed: items.filter((item: Space) => item.status === 'done').length,
      } };
    },
    listAgentPage: async () => {
      const items = await calls.listAllAgents();
      return { items, total: items.length, nextCursor: null, counts: { running: 0, waiting: 0, completed: 0, failed: 0 } };
    },
    listActivityPage: async (request: { limit: number }) => {
      const events: SpaceEvent[] = await calls.listEvents(request.limit);
      const items = events.map(event => ({
        key: event.id, kind: 'event', spaceId: null, at: Date.parse(event.created_at),
        title: event.space_description ?? '', client: event.space_client, icon: '', variant: 'completed',
        agentCount: 0, hasSession: !!event.session_id, duration: '', rescheduled: 0,
      }));
      return { items, total: items.length, nextCursor: null };
    },
    getActiveSessions: calls.getActiveSessions,
    listAllAgents: calls.listAllAgents,
    listSkills: calls.listSkills,
    listEvents: calls.listEvents,
    listPersonas: calls.listPersonas,
    listCanvasArtifacts: calls.listCanvasArtifacts,
    listAllCanvasArtifacts: calls.listAllCanvasArtifacts,
    onAgentStatusChanged: (cb: (d: unknown) => void) => { fire.agentStatus = cb; },
    onAgentApprovalNeeded: (cb: (d: unknown) => void) => { fire.agentApproval = cb; },
    onAgentApprovalResolved: (cb: (d: unknown) => void) => { fire.agentApprovalResolved = cb; },
    onAgentCompleted: (cb: (d: unknown) => void) => { fire.agentCompleted = cb; },
    onAgentYoloChanged: (cb: (d: unknown) => void) => { fire.agentYolo = cb; },
    onAgentRemoteChanged: (cb: (d: unknown) => void) => { fire.agentRemote = cb; },
    onAgentPresenceStarted: (cb: (d: unknown) => void) => { fire.agentPresenceStarted = cb; },
    onAgentPresenceEnded: (cb: (d: unknown) => void) => { fire.agentPresenceEnded = cb; },
    onSpaceProcessed: (cb: (id: string) => void) => { fire.spaceProcessed = cb; },
    onSpaceTitleUpdated: (cb: (data: { spaceId: string; title: string }) => void) => { fire.spaceTitleUpdated = cb; },
    onRecurrenceApplied: (cb: (id: string) => void) => { fire.recurrenceApplied = cb; },
    onSkillsChanged: (cb: () => void) => { fire.skillsChanged = cb; },
    onCanvasArtifactPublished: (cb: (d: { spaceId: string; artifactId: string; title: string }) => void) => {
      fire.canvasArtifactPublished = cb;
      return () => {};
    },
    onWorkspaceChanged: (cb: (path: string | null) => void) => { fire.workspaceChanged = cb; },
  } as unknown as WhimAPI;

  return { api, fire, calls };
}

function resetStores(): void {
  spaceStore.setSpaces([]);
  spaceStore.setFilter('open');
  spaceStore.setSearchResults(null);
  spaceStore.setSearchMode(false);
  spaceStore.setActiveSearchQuery('');
  spaceStore.setFocusedSpace(null);
  spaceStore.setCanvasSpace(null);
  spaceStore.setSelectedIndex(-1);

  agentStore.reset();

  skillStore.setSkills([]);
  historyStore.reset();
  personaStore.setPersonas([]);
  canvasArtifactStore.clear();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function space(id: string): Space {
  return {
    id, description: id, body: null, raw_text: null, client: null,
    due_at: null, due_at_utc: null, recurrence: null, completed_at: null,
    folder: null, session_id: null, source_skill_id: null, attachments: [],
    status: 'captured', created_at: '', updated_at: '',
  };
}

function agent(id: string): AgentListAllItem {
  return {
    agentId: id, sessionId: id, spaceId: 's1', status: 'running', summary: '',
    selectedText: '', quotedText: '', anchor: { quote: '', prefix: '', suffix: '' },
    createdAt: '', pendingApprovalId: null, pendingPermissionKind: null,
    pendingIntention: null, pendingPath: null, source: 'sdk', personaHandle: null,
    yoloMode: false, sandboxed: false, runLocation: 'local',
  };
}

function skill(id: string): Skill {
  return {
    id, name: id, description: '', emoji: '', folder: '', filePath: '',
    schedule: null, schedule_time: null, schedule_day: null, next_run_at: null,
    last_run_at: null, created_at: '', updated_at: '',
  };
}

function persona(id: string): AgentPersona {
  return { id, handle: id, instructions: '', model: '', runLocation: 'local' };
}

function event(id: string): SpaceEvent {
  return {
    id, space_id: id, event_type: 'completed', due_at: null, due_at_utc: null,
    completed_at: null, recurrence_json: null, created_at: '',
    space_description: id, space_client: null, session_id: null,
  };
}

function artifact(id: string): SpaceCanvasArtifact {
  return { artifactId: id, spaceId: 's1', title: id, published: true, updatedAt: '', url: `whim-artifact://space/s1/${id}/index.html` };
}

describe('ipc-bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetIpcBridgeForTests();
    resetStores();
  });

  afterEach(() => {
    _resetIpcBridgeForTests();
    vi.useRealTimers();
  });

  // -- install idempotency ----------------------------------------------------

  it('installIpcBridge is idempotent (second call is a no-op)', () => {
    const m1 = makeMock();
    const m2 = makeMock();

    installIpcBridge(m1.api);
    installIpcBridge(m2.api);

    // Second mock never had its `on*` callbacks invoked.
    expect(m2.fire.agentApproval).toBeUndefined();
    // First mock did.
    expect(m1.fire.agentApproval).toBeTypeOf('function');
  });

  // -- pure store mutations ---------------------------------------------------

  it('routes onAgentApprovalNeeded to agentStore.setApproval', () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.agentApproval({
      agentId: 'a1',
      requestId: 'req-1',
      permissionKind: 'file_write',
      intention: 'Edit a config',
      path: '/etc/c',
    });

    expect(agentStore.getState().approvals.get('a1')).toEqual({
      agentId: 'a1',
      requestId: 'req-1',
      permissionKind: 'file_write',
      intention: 'Edit a config',
      path: '/etc/c',
    });
  });

  it('routes onAgentYoloChanged to agentStore.setYoloMode', () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.agentYolo({ agentId: 'a1', enabled: true });
    expect(agentStore.getState().yoloMode.get('a1')).toBe(true);

    m.fire.agentYolo({ agentId: 'a1', enabled: false });
    expect(agentStore.getState().yoloMode.has('a1')).toBe(false);
  });

  it('routes onAgentRemoteChanged to agentStore.setRemoteState', () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.agentRemote({ agentId: 'a1', enabled: true, url: 'https://x' });
    expect(agentStore.getState().remoteState.get('a1')).toEqual({ enabled: true, url: 'https://x' });

    m.fire.agentRemote({ agentId: 'a1', enabled: false });
    expect(agentStore.getState().remoteState.has('a1')).toBe(false);
  });

  it('routes onAgentPresenceStarted/Ended to agentStore.setPresence/clearPresence', () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.agentPresenceStarted({
      agentId: 'a1',
      spaceId: 's1',
      persona: { name: 'Alice', handle: 'alice' },
    });
    expect(agentStore.getState().presence.get('a1')).toEqual({
      agentId: 'a1',
      spaceId: 's1',
      persona: { name: 'Alice', handle: 'alice' },
    });

    m.fire.agentPresenceEnded({ agentId: 'a1', spaceId: 's1' });
    expect(agentStore.getState().presence.has('a1')).toBe(false);
  });

  // -- status changes ---------------------------------------------------------

  it('onAgentStatusChanged clears the approval when status leaves waiting-approval', () => {
    const m = makeMock();
    installIpcBridge(m.api);

    agentStore.setApproval('a1', {
      agentId: 'a1',
      requestId: 'r1',
      permissionKind: 'p',
    });
    expect(agentStore.getState().approvals.has('a1')).toBe(true);

    m.fire.agentStatus({ agentId: 'a1', status: 'running' });
    expect(agentStore.getState().approvals.has('a1')).toBe(false);
  });

  it('onAgentStatusChanged keeps the approval when status is still waiting-approval', () => {
    const m = makeMock();
    installIpcBridge(m.api);

    agentStore.setApproval('a1', {
      agentId: 'a1',
      requestId: 'r1',
      permissionKind: 'p',
    });
    m.fire.agentStatus({ agentId: 'a1', status: 'waiting-approval' });
    expect(agentStore.getState().approvals.has('a1')).toBe(true);
  });

  // -- debounced refetches ----------------------------------------------------

  it('onAgentStatusChanged debounces a spaces snapshot refresh', async () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.agentStatus({ agentId: 'a1', status: 'running' });
    m.fire.agentStatus({ agentId: 'a1', status: 'completed' });
    m.fire.agentStatus({ agentId: 'a1', status: 'completed' });

    expect(m.calls.list).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(310);

    // Coalesced into a single fetch round
    expect(m.calls.list).toHaveBeenCalledTimes(1);
    expect(m.calls.getActiveSessions).toHaveBeenCalledTimes(1);
    expect(m.calls.listAllAgents).toHaveBeenCalledTimes(1);
  });

  it('onAgentCompleted debounces a snapshot refresh', async () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.agentCompleted({ agentId: 'a1' });
    m.fire.agentCompleted({ agentId: 'a2' });
    expect(m.calls.list).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(310);
    expect(m.calls.list).toHaveBeenCalledTimes(1);
  });

  it('onSpaceProcessed debounces a spaces snapshot', async () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.spaceProcessed('s1');
    m.fire.spaceProcessed('s2');

    await vi.advanceTimersByTimeAsync(310);
    expect(m.calls.list).toHaveBeenCalledTimes(1);
  });

  it('onSpaceTitleUpdated updates the store and debounces a spaces snapshot', async () => {
    const space = { id: 's1', description: 'Old title', body: null, raw_text: null, client: null, due_at: null, due_at_utc: null, recurrence: null, completed_at: null, folder: null, session_id: null, source_skill_id: null, attachments: [], status: 'captured' as const, created_at: '', updated_at: '' };
    const m = makeMock({ list: [{ ...space, description: 'New title' }] });
    spaceStore.setSpaces([space]);
    installIpcBridge(m.api);

    m.fire.spaceTitleUpdated({ spaceId: 's1', title: 'New title' });
    expect(spaceStore.getSpace('s1')?.description).toBe('New title');

    await vi.advanceTimersByTimeAsync(310);
    expect(m.calls.list).toHaveBeenCalledTimes(1);
  });

  it('onRecurrenceApplied debounces a spaces snapshot', async () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.recurrenceApplied('s1');
    await vi.advanceTimersByTimeAsync(310);
    expect(m.calls.list).toHaveBeenCalledTimes(1);
  });

  // -- skills & workspace -----------------------------------------------------

  it('onSkillsChanged schedules a skills snapshot fetch', async () => {
    const m = makeMock({ listSkills: [{ id: 's1', name: 'Test', description: '', emoji: '🧩' }] });
    installIpcBridge(m.api);

    m.fire.skillsChanged();
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(m.calls.listSkills).toHaveBeenCalledTimes(1);
  });

  it('onCanvasArtifactPublished refreshes only the space that published', async () => {
    const m = makeMock({
      listCanvasArtifacts: [{
        artifactId: 'questions',
        spaceId: 's1',
        title: 'Open questions',
        published: true,
        updatedAt: '2024-01-01T00:00:00.000Z',
        url: 'whim-artifact://space/s1/questions/index.html',
      }],
    });
    installIpcBridge(m.api);

    m.fire.canvasArtifactPublished({ spaceId: 's1', artifactId: 'questions', title: 'Open questions' });
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(m.calls.listCanvasArtifacts).toHaveBeenCalledWith('s1');
    expect(m.calls.listAllCanvasArtifacts).not.toHaveBeenCalled();
    expect(canvasArtifactStore.getPrimary('s1')?.artifactId).toBe('questions');
  });

  it('onWorkspaceChanged with a path loads spaces, skills, and personas', async () => {
    const m = makeMock();
    installIpcBridge(m.api);

    m.fire.workspaceChanged('/some/path');
    await vi.runAllTimersAsync();
    await Promise.resolve();

    expect(m.calls.list).toHaveBeenCalledTimes(1);
    expect(m.calls.listSkills).toHaveBeenCalledTimes(1);
    expect(m.calls.listPersonas).toHaveBeenCalledTimes(1);
    expect(m.calls.listAllCanvasArtifacts).toHaveBeenCalledTimes(1);
  });

  it('onWorkspaceChanged with null clears stores', () => {
    const m = makeMock();
    installIpcBridge(m.api);

    // Seed
    spaceStore.setSpaces([{ id: 's', description: '', client: null, due_at: null, due_at_utc: null, recurrence: null, completed_at: null, folder: null, session_id: null, source_skill_id: null, status: 'captured', created_at: '', updated_at: '' }]);
    agentStore.setAgents([{ agentId: 'a', sessionId: 'sess', status: 'running', summary: '', selectedText: '', quotedText: '', anchor: { quote: '', prefix: '', suffix: '' }, spaceId: 's', createdAt: '', pendingApprovalId: null, pendingPermissionKind: null, pendingIntention: null, pendingPath: null, source: 'sdk', personaHandle: null, yoloMode: false, sandboxed: false, runLocation: 'local' }]);
    agentStore.setActiveSessionIntents(new Set(['s']));
    agentStore.setApproval('a', { agentId: 'a', requestId: 'r', permissionKind: 'file_write' });
    agentStore.setSandboxBlock({ agentId: 'a', requestId: 'sb', source: 'permission', kind: 'write', target: '/tmp/file' });
    agentStore.addStep('a', { toolCallId: 't', label: 'Editing file', status: 'running' });
    agentStore.setPresence('a', { agentId: 'a', spaceId: 's', persona: { name: 'Agent', handle: 'agent' } });
    agentStore.setYoloMode('a', true);
    agentStore.setRemoteState('a', { enabled: true, url: 'http://remote' });
    skillStore.setSkills([{ id: 'k', name: '', description: '', emoji: '', folder: '', filePath: '', schedule: null, schedule_time: null, schedule_day: null, next_run_at: null, last_run_at: null, created_at: '', updated_at: '' }]);
    historyStore.setEvents([{ id: 'e', space_id: 's', event_type: 'completed', due_at: null, due_at_utc: null, completed_at: null, recurrence_json: null, created_at: '', space_description: '', space_client: null, session_id: null }]);
    personaStore.setPersonas([{ id: 'p', handle: 'h', instructions: '', model: '', runLocation: 'local' }]);

    m.fire.workspaceChanged(null);

    expect(spaceStore.getState().spaces).toEqual([]);
    expect(agentStore.getState().agents).toEqual([]);
    expect(agentStore.getState().activeSessionSpaces).toEqual(new Set());
    expect(agentStore.getState().approvals).toEqual(new Map());
    expect(agentStore.getState().sandboxBlocks).toEqual(new Map());
    expect(agentStore.getState().steps).toEqual(new Map());
    expect(agentStore.getState().presence).toEqual(new Map());
    expect(agentStore.getState().yoloMode).toEqual(new Map());
    expect(agentStore.getState().remoteState).toEqual(new Map());
    expect(skillStore.getState().skills).toEqual([]);
    expect(historyStore.getState().events).toEqual([]);
    expect(personaStore.getState().personas).toEqual([]);
  });
});

describe('snapshot loaders', () => {
  it('rejects explicit failed navigation without changing visible rows or the refresh cursor', async () => {
    const { api, calls } = makeMock({ list: [space('visible')] });
    const pages = vi.spyOn(api, 'listSpacePage');
    await loadSpacesSnapshot(api, { cursor: 'successful-page' });
    const visible = spaceStore.getState().spaces;
    calls.list.mockRejectedValueOnce(new Error('page unavailable'));
    await expect(loadSpacesSnapshot(api, { cursor: 'failed-page' })).rejects.toThrow('Unable to refresh spaces');
    expect(spaceStore.getState().spaces).toBe(visible);
    await loadSpacesSnapshot(api, { force: true });
    expect(pages.mock.calls.slice(-1)[0][0]?.cursor).toBe('successful-page');
  });
  beforeEach(() => {
    _resetIpcBridgeForTests();
    resetStores();
  });

  describe('refresh ownership and generations', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      _resetIpcBridgeForTests();
      resetStores();
    });
    afterEach(() => {
      _resetIpcBridgeForTests();
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('coalesces duplicate status, completion, and processed events into one three-call round', async () => {
      const m = makeMock();
      installIpcBridge(m.api);
      for (let i = 0; i < 100; i++) {
        m.fire.agentStatus({ agentId: 'a1', status: 'completed' });
        m.fire.agentCompleted({ agentId: 'a1', summary: 'done' });
        m.fire.spaceProcessed('s1');
      }
      await vi.advanceTimersByTimeAsync(310);
      expect(m.calls.list).toHaveBeenCalledTimes(1);
      expect(m.calls.getActiveSessions).toHaveBeenCalledTimes(1);
      expect(m.calls.listAllAgents).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])('shares an in-flight agent request with a spaces reader (agents first: %s)', async agentsFirst => {
      const m = makeMock();
      const pending = deferred<AgentListAllItem[]>();
      m.calls.listAllAgents.mockReturnValueOnce(pending.promise);
      const first = agentsFirst ? loadAgentsSnapshot(m.api) : loadSpacesSnapshot(m.api);
      const second = agentsFirst ? loadSpacesSnapshot(m.api) : loadAgentsSnapshot(m.api);
      const third = loadSpacesSnapshot(m.api);
      expect(m.calls.listAllAgents).toHaveBeenCalledTimes(1);
      expect(m.calls.list).toHaveBeenCalledTimes(1);
      pending.resolve([agent('a1')]);
      await Promise.all([first, second, third]);
      expect(agentStore.getState().agents.map(a => a.agentId)).toEqual(['a1']);
    });

    it('applies spaces without waiting for slower agent/session reads', async () => {
      const m = makeMock({ list: [space('s1')] });
      const agents = deferred<AgentListAllItem[]>();
      const active = deferred<string[]>();
      m.calls.listAllAgents.mockReturnValueOnce(agents.promise);
      m.calls.getActiveSessions.mockReturnValueOnce(active.promise);
      const pending = loadSpacesSnapshot(m.api);
      await Promise.resolve();
      await Promise.resolve();
      expect(spaceStore.getState().spaces).toEqual([space('s1')]);
      agents.resolve([]);
      active.resolve([]);
      await pending;
    });

    it('keeps keyed payloads ahead of older snapshots and issues only one trailing round', async () => {
      const oldSpace = space('s1');
      const oldAgent = agent('a1');
      spaceStore.setSpaces([oldSpace]);
      agentStore.setAgents([oldAgent]);
      const m = makeMock({
        list: [{ ...oldSpace, description: 'fresh' }],
        listAllAgents: [{ ...oldAgent, status: 'completed', summary: 'done' }],
      });
      installIpcBridge(m.api);
      const spaces = deferred<Space[]>();
      const agents = deferred<AgentListAllItem[]>();
      m.calls.list.mockReturnValueOnce(spaces.promise);
      m.calls.listAllAgents.mockReturnValueOnce(agents.promise);
      const pending = loadSpacesSnapshot(m.api);
      m.fire.spaceTitleUpdated({ spaceId: 's1', title: 'fresh' });
      m.fire.agentStatus({ agentId: 'a1', status: 'completed', summary: 'done' });
      m.fire.agentCompleted({ agentId: 'a1', summary: 'done' });
      expect(spaceStore.getSpace('s1')?.description).toBe('fresh');
      expect(agentStore.getState().agents[0].status).toBe('completed');
      spaces.resolve([oldSpace]);
      agents.resolve([oldAgent]);
      await pending;
      expect(spaceStore.getSpace('s1')?.description).toBe('fresh');
      expect(agentStore.getState().agents[0].status).toBe('completed');
      await vi.advanceTimersByTimeAsync(1000);
      expect(m.calls.list).toHaveBeenCalledTimes(2);
      expect(m.calls.listAllAgents).toHaveBeenCalledTimes(2);
      expect(m.calls.getActiveSessions).toHaveBeenCalledTimes(2);
    });

    it('serializes a trailing refresh when the debounce expires during a flight', async () => {
      const m = makeMock({ list: [space('new')] });
      installIpcBridge(m.api);
      const slow = deferred<Space[]>();
      m.calls.list.mockReturnValueOnce(slow.promise);
      const pending = loadSpacesSnapshot(m.api);
      m.fire.spaceProcessed('new');
      await vi.advanceTimersByTimeAsync(310);
      expect(m.calls.list).toHaveBeenCalledTimes(1);
      slow.resolve([space('old')]);
      await pending;
      expect(m.calls.list).toHaveBeenCalledTimes(2);
      expect(spaceStore.getState().spaces.map(s => s.id)).toEqual(['new']);
    });

    it('does not erase an optimistic capture with an older list response', async () => {
      const m = makeMock();
      const slow = deferred<Space[]>();
      m.calls.list.mockReturnValueOnce(slow.promise);
      const pending = loadSpacesSnapshot(m.api);
      spaceStore.upsertSpace(space('captured'));
      slow.resolve([]);
      await pending;
      expect(spaceStore.getState().spaces).toEqual([toSpaceSummary(space('captured'))]);
    });

    it.each(['hidden desktop', 'settings', 'prewarmed canvas'])('defers collections in %s while delivering approvals and presence immediately', async () => {
      let visible = false;
      const m = makeMock({ list: [space('s1')], listAllAgents: [agent('a1')] });
      installIpcBridge(m.api, { isListVisible: () => visible });
      await loadSpacesSnapshot(m.api);
      await loadSkillsSnapshot(m.api);
      await loadCanvasArtifactsSnapshot(m.api);
      m.fire.agentApproval({ agentId: 'a1', requestId: 'r1', permissionKind: 'write' });
      m.fire.agentPresenceStarted({ agentId: 'a1', spaceId: 's1', persona: { name: 'Agent', handle: 'agent' } });
      m.fire.spaceProcessed('s1');
      m.fire.skillsChanged();
      m.fire.canvasArtifactPublished({ spaceId: 's1', artifactId: 'report', title: 'Report' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(agentStore.getState().approvals.has('a1')).toBe(true);
      expect(agentStore.getState().presence.has('a1')).toBe(true);
      for (const call of Object.values(m.calls)) expect(call).not.toHaveBeenCalled();
      visible = true;
      await Promise.all([refreshVisibleCollections(), refreshVisibleCollections()]);
      expect(m.calls.list).toHaveBeenCalledTimes(1);
      expect(m.calls.listAllAgents).toHaveBeenCalledTimes(1);
      expect(m.calls.getActiveSessions).toHaveBeenCalledTimes(1);
      expect(m.calls.listSkills).toHaveBeenCalledTimes(1);
      expect(m.calls.listCanvasArtifacts).toHaveBeenCalledTimes(1);
      expect(spaceStore.getSpace('s1')).toBeDefined();
    });

    it('allows explicit settings/canvas data demands without loading spaces or agents', async () => {
      const m = makeMock({ listSkills: [skill('sk1')], listPersonas: [persona('p1')] });
      installIpcBridge(m.api, { isListVisible: () => false });
      await Promise.all([
        loadSkillsSnapshot(m.api, { force: true }),
        loadPersonasSnapshot(m.api, { force: true }),
      ]);
      expect(skillStore.getState().skills[0].id).toBe('sk1');
      expect(personaStore.getState().personas[0].id).toBe('p1');
      expect(m.calls.list).not.toHaveBeenCalled();
      expect(m.calls.listAllAgents).not.toHaveBeenCalled();
    });

    it('does not mark hidden or failed startup reads as hydrated', async () => {
      spaceStore.reset();
      personaStore.reset();
      let visible = false;
      const m = makeMock();
      installIpcBridge(m.api, { isListVisible: () => visible });
      await Promise.all([loadSpacesSnapshot(m.api), loadPersonasSnapshot(m.api)]);
      expect(spaceStore.getState().hydrated).toBe(false);
      expect(personaStore.getState().hydrated).toBe(false);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      m.calls.list.mockRejectedValueOnce(new Error('failed'));
      m.calls.listPersonas.mockRejectedValueOnce(new Error('failed'));
      visible = true;
      await refreshVisibleCollections();
      expect(spaceStore.getState().hydrated).toBe(false);
      expect(personaStore.getState().hydrated).toBe(false);
    });

    it('does not retain a force override after concurrent explicit readers finish', async () => {
      const m = makeMock();
      installIpcBridge(m.api, { isListVisible: () => false });
      const slow = deferred<Skill[]>();
      m.calls.listSkills.mockReturnValueOnce(slow.promise);
      const first = loadSkillsSnapshot(m.api, { force: true });
      const second = loadSkillsSnapshot(m.api, { force: true });
      slow.resolve([]);
      await Promise.all([first, second]);
      await loadSkillsSnapshot(m.api);
      expect(m.calls.listSkills).toHaveBeenCalledTimes(1);
    });

    it('defers a queued follow-up if the window hides during an in-flight read', async () => {
      let visible = true;
      const m = makeMock({ list: [space('fresh')] });
      installIpcBridge(m.api, { isListVisible: () => visible });
      const slow = deferred<Space[]>();
      m.calls.list.mockReturnValueOnce(slow.promise);
      const pending = loadSpacesSnapshot(m.api);
      m.fire.spaceProcessed('s1');
      visible = false;
      await vi.advanceTimersByTimeAsync(310);
      slow.resolve([space('stale')]);
      await pending;
      expect(m.calls.list).toHaveBeenCalledTimes(1);
      expect(spaceStore.getState().spaces).toEqual([]);
      visible = true;
      await refreshVisibleCollections();
      expect(m.calls.list).toHaveBeenCalledTimes(2);
      expect(spaceStore.getState().spaces[0].id).toBe('fresh');
    });

    it.each(['/workspace-b', null])('drops all old-workspace results after switching to %s', async path => {
      const m = makeMock({
        list: [space('new')], getActiveSessions: ['new'], listAllAgents: [agent('new')],
        listSkills: [skill('new')], listPersonas: [persona('new')], listEvents: [event('new')],
        listAllCanvasArtifacts: [artifact('new')],
      });
      installIpcBridge(m.api);
      const oldSpaces = deferred<Space[]>();
      const oldAgents = deferred<AgentListAllItem[]>();
      const oldActive = deferred<string[]>();
      const oldSkills = deferred<Skill[]>();
      const oldPersonas = deferred<AgentPersona[]>();
      const oldHistory = deferred<SpaceEvent[]>();
      const oldArtifacts = deferred<{ artifacts: SpaceCanvasArtifact[] }>();
      const oldKeyedArtifacts = deferred<{ artifacts: SpaceCanvasArtifact[] }>();
      m.calls.list.mockReturnValueOnce(oldSpaces.promise);
      m.calls.listAllAgents.mockReturnValueOnce(oldAgents.promise);
      m.calls.getActiveSessions.mockReturnValueOnce(oldActive.promise);
      m.calls.listSkills.mockReturnValueOnce(oldSkills.promise);
      m.calls.listPersonas.mockReturnValueOnce(oldPersonas.promise);
      m.calls.listEvents.mockReturnValueOnce(oldHistory.promise);
      m.calls.listAllCanvasArtifacts.mockReturnValueOnce(oldArtifacts.promise);
      m.calls.listCanvasArtifacts.mockReturnValueOnce(oldKeyedArtifacts.promise);
      const pending = Promise.all([
        loadSpacesSnapshot(m.api), loadSkillsSnapshot(m.api), loadPersonasSnapshot(m.api),
        loadHistorySnapshot(m.api), loadCanvasArtifactsSnapshot(m.api), loadSpaceArtifacts(m.api, 's1'),
      ]);
      spaceStore.setSearchResults([space('old')]);
      spaceStore.setFocusedSpace('old');
      spaceStore.setRecallHint('old', { space_id: 'old', description: 'old', completed_at: null, confidence: 1 });
      m.fire.workspaceChanged(path);
      await vi.runAllTimersAsync();
      expect(spaceStore.getState().searchResults).toBeNull();
      expect(spaceStore.getState().focusedSpaceId).toBeNull();
      expect(spaceStore.getState().recallHints.size).toBe(0);
      oldSpaces.resolve([space('old')]);
      oldAgents.resolve([agent('old')]);
      oldActive.resolve(['old']);
      oldSkills.resolve([skill('old')]);
      oldPersonas.resolve([persona('old')]);
      oldHistory.resolve([event('old')]);
      oldArtifacts.resolve({ artifacts: [artifact('old')] });
      oldKeyedArtifacts.resolve({ artifacts: [artifact('old')] });
      await pending;
      const expected = path ? ['new'] : [];
      expect(spaceStore.getState().spaces.map(s => s.id)).toEqual(expected);
      expect(agentStore.getState().agents.map(a => a.agentId)).toEqual(expected);
      expect([...agentStore.getState().activeSessionSpaces]).toEqual(expected);
      expect(skillStore.getState().skills.map(s => s.id)).toEqual(expected);
      expect(personaStore.getState().personas.map(p => p.id)).toEqual(expected);
      expect(historyStore.getState().page?.items.map(e => e.key) ?? []).toEqual(expected);
      expect(canvasArtifactStore.getSpaceArtifacts('s1').map(a => a.artifactId)).toEqual(expected);
    });

    it('does not reintroduce a resolved approval from an older snapshot', async () => {
      const pendingAgent = { ...agent('a1'), status: 'waiting-approval' as const, pendingApprovalId: 'r1' };
      const m = makeMock();
      installIpcBridge(m.api);
      const slow = deferred<AgentListAllItem[]>();
      m.calls.listAllAgents.mockReturnValueOnce(slow.promise);
      const pending = loadAgentsSnapshot(m.api);
      m.fire.agentApproval({ agentId: 'a1', requestId: 'r1', permissionKind: 'write' });
      m.fire.agentApprovalResolved({ agentId: 'a1', requestId: 'r1', approved: true });
      slow.resolve([pendingAgent]);
      await pending;
      expect(agentStore.getState().approvals.size).toBe(0);
    });

    it('consumes an event invalidation when an explicit mutation refresh already handled it', async () => {
      const m = makeMock();
      installIpcBridge(m.api);
      m.fire.spaceProcessed('s1');
      m.fire.skillsChanged();
      await Promise.all([loadSpacesSnapshot(m.api, { invalidate: true }), loadSkillsSnapshot(m.api)]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(m.calls.list).toHaveBeenCalledTimes(1);
      expect(m.calls.listAllAgents).toHaveBeenCalledTimes(1);
      expect(m.calls.listSkills).toHaveBeenCalledTimes(1);
    });

    it('does not let a full artifact snapshot overwrite a newer keyed publication', async () => {
      const m = makeMock({ listCanvasArtifacts: [artifact('new')] });
      const slow = deferred<{ artifacts: SpaceCanvasArtifact[] }>();
      m.calls.listAllCanvasArtifacts.mockReturnValueOnce(slow.promise);
      const full = loadCanvasArtifactsSnapshot(m.api);
      await loadSpaceArtifacts(m.api, 's1');
      slow.resolve({ artifacts: [artifact('old')] });
      await full;
      expect(canvasArtifactStore.getPrimary('s1')?.artifactId).toBe('new');
    });

    it('does not let an older keyed artifact response overwrite a newer full snapshot', async () => {
      const m = makeMock({ listAllCanvasArtifacts: [artifact('new')] });
      const slow = deferred<{ artifacts: SpaceCanvasArtifact[] }>();
      m.calls.listCanvasArtifacts.mockReturnValueOnce(slow.promise);
      const keyed = loadSpaceArtifacts(m.api, 's1');
      await loadCanvasArtifactsSnapshot(m.api);
      slow.resolve({ artifacts: [artifact('old')] });
      await keyed;
      expect(canvasArtifactStore.getPrimary('s1')?.artifactId).toBe('new');
    });

    it('retains the last good snapshot on failure, reports only resource identity, and retries on demand', async () => {
      spaceStore.setSpaces([space('kept')]);
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const m = makeMock({ list: [space('fresh')] });
      m.calls.list.mockRejectedValueOnce(new Error('private document or credential'));
      await loadSpacesSnapshot(m.api);
      expect(spaceStore.getState().spaces[0].id).toBe('kept');
      expect(log).toHaveBeenCalledWith('[refresh] collection request failed', { collection: 'spaces' });
      expect(JSON.stringify(log.mock.calls)).not.toContain('private document');
      await loadSpacesSnapshot(m.api);
      expect(spaceStore.getState().spaces[0].id).toBe('fresh');
    });

    it('rejects a failed explicit settings read rather than letting its caller persist an empty fallback', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const m = makeMock();
      m.calls.listPersonas.mockRejectedValueOnce(new Error('failed'));
      await expect(loadPersonasSnapshot(m.api, { force: true })).rejects.toThrow('Unable to refresh personas');
    });

    it('records bounded numeric request timings without IDs, paths, content or errors', async () => {
      const m = makeMock();
      for (const id of ['private-space', 'credential-like-id', 'another-space']) {
        await loadSpaceArtifacts(m.api, id);
      }
      const timings = getRefreshTimings(m.api);
      expect(timings).toHaveLength(1);
      expect(timings[0]).toEqual({
        collection: 'artifact', requests: 3, failures: 0,
        lastDurationMs: expect.any(Number), maxDurationMs: expect.any(Number), totalDurationMs: expect.any(Number),
      });

      expect(timings[0].totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(timings)).not.toMatch(/private-space|credential-like-id|another-space/);
    });

    it('serializes different history limits without returning a smaller snapshot as a larger request', async () => {
      const m = makeMock({ listEvents: [event('large')] });
      const slow = deferred<SpaceEvent[]>();
      m.calls.listEvents.mockReturnValueOnce(slow.promise);
      const first = loadHistorySnapshot(m.api, 50);
      const second = loadHistorySnapshot(m.api, 200);
      expect(m.calls.listEvents).toHaveBeenCalledTimes(1);
      slow.resolve([event('small')]);
      await Promise.all([first, second]);
      expect(m.calls.listEvents.mock.calls).toEqual([[50], [100]]);
      expect(historyStore.getState().page?.items[0].key).toBe('large');
    });

    it('hydrates once per visible transition even when native and browser signals arrive after completion', async () => {
      let visible = true;
      const m = makeMock();
      installIpcBridge(m.api, { isListVisible: () => visible });
      await refreshVisibleCollections();
      await vi.advanceTimersByTimeAsync(50);
      await refreshVisibleCollections();
      expect(m.calls.list).toHaveBeenCalledTimes(1);
      visible = false;
      await refreshVisibleCollections();
      visible = true;
      await refreshVisibleCollections();
      expect(m.calls.list).toHaveBeenCalledTimes(2);
      expect(m.calls.listAllAgents).toHaveBeenCalledTimes(2);
      expect(m.calls.getActiveSessions).toHaveBeenCalledTimes(2);
    });
  });

  afterEach(() => {
    _resetIpcBridgeForTests();
  });

  // -- loadSpacesSnapshot ----------------------------------------------------

  it('loadSpacesSnapshot applies fresh results from all three calls', async () => {
    const space = { id: 's1', description: 'hi', body: null, raw_text: null, client: null, due_at: null, due_at_utc: null, recurrence: null, completed_at: null, folder: null, session_id: null, source_skill_id: null, attachments: [], status: 'captured' as const, created_at: '', updated_at: '' };
    const agent = { agentId: 'a1', sessionId: 'sess', status: 'running' as const, summary: '', selectedText: '', quotedText: '', anchor: { quote: '', prefix: '', suffix: '' }, spaceId: 's1', createdAt: '', pendingApprovalId: null, pendingPermissionKind: null, pendingIntention: null, pendingPath: null, source: 'sdk' as const, personaHandle: null, yoloMode: false };
    const m = makeMock({ list: [space], getActiveSessions: ['s1'], listAllAgents: [agent] });

    await loadSpacesSnapshot(m.api);

    expect(spaceStore.getState().spaces).toEqual([space]);
    expect(agentStore.getState().activeSessionSpaces.has('s1')).toBe(true);
    expect(agentStore.getState().agents).toEqual([agent]);
  });

  it('loadSpacesSnapshot drops stale space results when spaceStore is bumped', async () => {
    let resolveList!: (v: unknown[]) => void;
    const slowList = new Promise<unknown[]>(r => { resolveList = r; });

    const m = makeMock();
    m.calls.list.mockReturnValueOnce(slowList);

    const first = loadSpacesSnapshot(m.api);

    // Newer spaces reservation invalidates the in-flight first
    spaceStore.nextRequestId();

    resolveList([{ id: 'STALE' } as unknown]);
    await first;

    // Stale spaces result must not be applied
    expect(spaceStore.getState().spaces).toEqual([]);
  });

  it('loadSpacesSnapshot still applies space results when only agentStore is bumped (cross-invalidation guard)', async () => {
    const space = { id: 's1', description: '', body: null, raw_text: null, client: null, due_at: null, due_at_utc: null, recurrence: null, completed_at: null, folder: null, session_id: null, source_skill_id: null, attachments: [], status: 'captured' as const, created_at: '', updated_at: '' };

    let resolveAgents!: (v: unknown[]) => void;
    const slowAgents = new Promise<unknown[]>(r => { resolveAgents = r; });

    const m = makeMock({ list: [space], getActiveSessions: ['s1'] });
    m.calls.listAllAgents.mockReturnValueOnce(slowAgents);

    const inflight = loadSpacesSnapshot(m.api);

    // A racing agents-only refresh bumps agentStore but NOT spaceStore.
    agentStore.nextRequestId();

    resolveAgents([{ STALE: true } as unknown]);
    await inflight;

    // Spaces are fresh; they must land even though agent results are dropped.
    expect(spaceStore.getState().spaces).toEqual([space]);
    expect(agentStore.getState().agents).toEqual([]);
  });

  it('loadSpacesSnapshot tolerates partial failures (Promise.allSettled)', async () => {
    const space = { id: 's1', description: '', body: null, raw_text: null, client: null, due_at: null, due_at_utc: null, recurrence: null, completed_at: null, folder: null, session_id: null, source_skill_id: null, attachments: [], status: 'captured' as const, created_at: '', updated_at: '' };
    const m = makeMock({ list: [space], getActiveSessions: ['s1'] });
    m.calls.listAllAgents.mockRejectedValueOnce(new Error('boom'));

    await loadSpacesSnapshot(m.api);

    expect(spaceStore.getState().spaces).toEqual([space]);
    expect(agentStore.getState().activeSessionSpaces.has('s1')).toBe(true);
    // listAllAgents failed — agents stay empty (didn't crash)
    expect(agentStore.getState().agents).toEqual([]);
  });

  // -- loadAgentsSnapshot ----------------------------------------------------

  it('loadAgentsSnapshot updates only agents', async () => {
    const agent = { agentId: 'a1', sessionId: 'sess', status: 'running' as const, summary: '', selectedText: '', quotedText: '', anchor: { quote: '', prefix: '', suffix: '' }, spaceId: 's1', createdAt: '', pendingApprovalId: null, pendingPermissionKind: null, pendingIntention: null, pendingPath: null, source: 'sdk' as const, personaHandle: null, yoloMode: false };
    const m = makeMock({ listAllAgents: [agent] });

    await loadAgentsSnapshot(m.api);

    expect(agentStore.getState().agents).toEqual([agent]);
    expect(m.calls.list).not.toHaveBeenCalled();
  });

  // -- loadHistorySnapshot ---------------------------------------------------

  it('loadHistorySnapshot stores events from listEvents()', async () => {
    const event = { id: 'e1', space_id: 's1', event_type: 'completed', due_at: null, due_at_utc: null, completed_at: '2024-01-01T00:00:00Z', recurrence_json: null, created_at: '2024-01-01T00:00:00Z', space_description: 'Test', space_client: null, session_id: null };
    const m = makeMock({ listEvents: [event] });

    await loadHistorySnapshot(m.api);

    expect(historyStore.getState().page?.items.map(row => row.key)).toEqual([event.id]);
    expect(m.calls.listEvents).toHaveBeenCalledWith(60);
  });

  it('loadHistorySnapshot accepts a custom limit', async () => {
    const m = makeMock();
    await loadHistorySnapshot(m.api, 50);
    expect(m.calls.listEvents).toHaveBeenCalledWith(50);
  });

  // -- loadSkillsSnapshot ----------------------------------------------------

  it('loadSkillsSnapshot stores skills from listSkills()', async () => {
    const skill = { id: 'sk1', name: 'Test', description: '', emoji: '🧩', folder: '', filePath: '', schedule: null, schedule_time: null, schedule_day: null, next_run_at: null, last_run_at: null, created_at: '', updated_at: '' };
    const m = makeMock({ listSkills: [skill] });

    await loadSkillsSnapshot(m.api);

    expect(skillStore.getState().skills).toEqual([skill]);
  });

  // -- loadPersonasSnapshot --------------------------------------------------

  it('loadPersonasSnapshot stores personas from listPersonas()', async () => {
    const persona = { id: 'p1', handle: 'alice', instructions: '', model: '', runLocation: 'local' as const };
    const m = makeMock({ listPersonas: [persona] });

    await loadPersonasSnapshot(m.api);

    expect(personaStore.getState().personas).toEqual([persona]);
  });
});
