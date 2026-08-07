import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WhimAPI } from '../ipc-client';
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
    getActiveSessions: calls.getActiveSessions,
    listAllAgents: calls.listAllAgents,
    listSkills: calls.listSkills,
    listEvents: calls.listEvents,
    listPersonas: calls.listPersonas,
    listCanvasArtifacts: calls.listCanvasArtifacts,
    listAllCanvasArtifacts: calls.listAllCanvasArtifacts,
    onAgentStatusChanged: (cb: (d: unknown) => void) => { fire.agentStatus = cb; },
    onAgentApprovalNeeded: (cb: (d: unknown) => void) => { fire.agentApproval = cb; },
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
    expect(m.calls.listAllAgents).toHaveBeenCalledTimes(2); // one for agents-only, one for spaces snapshot
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

  it('onSkillsChanged triggers a skills snapshot fetch (no debounce)', async () => {
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
    spaceStore.setSpaces([{ id: 's', description: '', body: null, raw_text: null, client: null, due_at: null, due_at_utc: null, recurrence: null, completed_at: null, folder: null, session_id: null, source_skill_id: null, attachments: [], status: 'captured', created_at: '', updated_at: '' }]);
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
  beforeEach(() => {
    _resetIpcBridgeForTests();
    resetStores();
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

    expect(historyStore.getState().events).toEqual([event]);
    expect(m.calls.listEvents).toHaveBeenCalledWith(200);
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
