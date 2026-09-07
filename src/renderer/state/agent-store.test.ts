import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentListAllItem } from '../../shared/ipc-contract';
import { agentStore, WORKER_PREVIEW_STEPS } from './agent-store';
import type { AgentApproval, AgentStep, AgentPresence, AgentSandboxBlock } from './agent-store';

function makeAgent(overrides: Partial<AgentListAllItem> & { agentId: string; spaceId: string }): AgentListAllItem {
  return {
    sessionId: 'sess-1',
    status: 'running',
    summary: 'Test agent',
    selectedText: '',
    quotedText: '',
    anchor: { quote: '', prefix: '', suffix: '' },
    createdAt: '2024-01-01T00:00:00Z',
    pendingApprovalId: null,
    pendingPermissionKind: null,
    pendingIntention: null,
    pendingPath: null,
    source: 'sdk',
    personaHandle: null,
    yoloMode: false,
    sandboxed: false,
    runLocation: 'local',
    ...overrides,
  };
}

describe('AgentStore', () => {
  it('bounds row previews and releases off-page steps without dropping pending approvals', () => {
    for (let n = 0; n < 100; n++) agentStore.addStep('old', { toolCallId: String(n), label: 'Preview', status: 'running' });
    expect(agentStore.getState().steps.get('old')).toHaveLength(WORKER_PREVIEW_STEPS);
    agentStore.setApproval('old', { agentId: 'old', requestId: 'pending', permissionKind: 'write' });
    agentStore.setPage({
      items: [makeAgent({ agentId: 'new', spaceId: 'space' })], total: 1000, nextCursor: null,
      counts: { running: 1000, waiting: 0, completed: 0, failed: 0 },
    });
    expect(agentStore.getState().steps.has('old')).toBe(false);
    expect(agentStore.getState().approvals.get('old')?.requestId).toBe('pending');
    agentStore.reset();
  });
  beforeEach(() => {
    // Reset singleton state between tests
    agentStore.setAgents([]);
    agentStore.setActiveSessionIntents(new Set());
    // Clear collections that have no bulk-reset method
    for (const id of agentStore.getState().processingSpaces) {
      agentStore.removeProcessingIntent(id);
    }
    for (const id of agentStore.getState().approvals.keys()) {
      agentStore.clearApproval(id);
    }
    for (const id of agentStore.getState().presence.keys()) {
      agentStore.clearPresence(id);
    }
    for (const id of agentStore.getState().yoloMode.keys()) {
      agentStore.setYoloMode(id, false);
    }
    for (const id of agentStore.getState().remoteState.keys()) {
      agentStore.setRemoteState(id, null);
    }
    // Steps: overwrite with empty arrays, then set a fresh agents list to drop stale keys
    for (const id of agentStore.getState().steps.keys()) {
      agentStore.setSteps(id, []);
    }
    // Clear sandbox blocks (Map of Maps — clear all requestIds for each agent).
    for (const [agentId, perAgent] of agentStore.getState().sandboxBlocks) {
      for (const requestId of perAgent.keys()) {
        agentStore.clearSandboxBlock(agentId, requestId);
      }
    }
  });

  // -- Initial state ----------------------------------------------------------

  it('has correct initial state after reset', () => {
    const state = agentStore.getState();
    expect(state.agents).toEqual([]);
    expect(state.processingSpaces.size).toBe(0);
    expect(state.activeSessionSpaces.size).toBe(0);
    expect(state.approvals.size).toBe(0);
    expect(state.sandboxBlocks.size).toBe(0);
    expect(state.steps.size).toBe(0);
    expect(state.presence.size).toBe(0);
    expect(state.yoloMode.size).toBe(0);
    expect(state.remoteState.size).toBe(0);
  });

  // -- setAgents() ------------------------------------------------------------

  it('setAgents() updates agents and notifies listeners', () => {
    const listener = vi.fn();
    const unsub = agentStore.subscribe(listener);

    const agents = [makeAgent({ agentId: 'a1', spaceId: 'i1' })];
    agentStore.setAgents(agents);

    expect(agentStore.getState().agents).toEqual(agents);
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
  });

  // -- Processing spaces -----------------------------------------------------

  it('addProcessingIntent() / removeProcessingIntent() work correctly', () => {
    agentStore.addProcessingIntent('space-1');
    expect(agentStore.getState().processingSpaces.has('space-1')).toBe(true);

    agentStore.addProcessingIntent('space-2');
    expect(agentStore.getState().processingSpaces.size).toBe(2);

    agentStore.removeProcessingIntent('space-1');
    expect(agentStore.getState().processingSpaces.has('space-1')).toBe(false);
    expect(agentStore.getState().processingSpaces.has('space-2')).toBe(true);
  });

  it('removeProcessingIntent() is safe when id is not present', () => {
    agentStore.removeProcessingIntent('nonexistent');
    expect(agentStore.getState().processingSpaces.size).toBe(0);
  });

  // -- Active session spaces -------------------------------------------------

  it('setActiveSessionIntents() updates the set', () => {
    agentStore.setActiveSessionIntents(new Set(['i1', 'i2']));
    const state = agentStore.getState();
    expect(state.activeSessionSpaces.has('i1')).toBe(true);
    expect(state.activeSessionSpaces.has('i2')).toBe(true);
    expect(state.activeSessionSpaces.size).toBe(2);
  });

  // -- Approvals --------------------------------------------------------------

  it('setApproval() / clearApproval() manage the approvals map', () => {
    const approval: AgentApproval = {
      agentId: 'a1',
      requestId: 'req-1',
      permissionKind: 'file_write',
      intention: 'Update config',
      path: '/etc/config',
    };

    agentStore.setApproval('a1', approval);
    expect(agentStore.getState().approvals.get('a1')).toEqual(approval);

    agentStore.clearApproval('a1');
    expect(agentStore.getState().approvals.has('a1')).toBe(false);
  });

  it('clearApproval() is safe when agentId is not present', () => {
    agentStore.clearApproval('nonexistent');
    expect(agentStore.getState().approvals.size).toBe(0);
  });

  // -- Sandbox blocks --------------------------------------------------------

  function makeBlock(overrides: Partial<AgentSandboxBlock> & { agentId: string; requestId: string }): AgentSandboxBlock {
    return {
      source: 'permission',
      kind: 'shell',
      target: '/some/path',
      ...overrides,
    };
  }

  it('setSandboxBlock() inserts a pending block for an agent', () => {
    const block = makeBlock({ agentId: 'a1', requestId: 'r1' });
    agentStore.setSandboxBlock(block);
    const perAgent = agentStore.getState().sandboxBlocks.get('a1');
    expect(perAgent?.get('r1')).toEqual(block);
    expect(agentStore.sandboxBlockCount()).toBe(1);
  });

  it('setSandboxBlock() supports multiple concurrent blocks per agent (keyed by requestId)', () => {
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r1', target: '/a' }));
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r2', target: '/b' }));
    const perAgent = agentStore.getState().sandboxBlocks.get('a1');
    expect(perAgent?.size).toBe(2);
    expect(perAgent?.get('r1')?.target).toBe('/a');
    expect(perAgent?.get('r2')?.target).toBe('/b');
    expect(agentStore.sandboxBlockCount()).toBe(2);
  });

  it('setSandboxBlock() updates in place when the same requestId fires twice', () => {
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r1', target: '/a' }));
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r1', target: '/a-updated' }));
    expect(agentStore.getState().sandboxBlocks.get('a1')?.size).toBe(1);
    expect(agentStore.getState().sandboxBlocks.get('a1')?.get('r1')?.target).toBe('/a-updated');
  });

  it('clearSandboxBlock() removes one block and keeps the agent entry when other blocks remain', () => {
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r1' }));
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r2' }));
    agentStore.clearSandboxBlock('a1', 'r1');
    const perAgent = agentStore.getState().sandboxBlocks.get('a1');
    expect(perAgent?.has('r1')).toBe(false);
    expect(perAgent?.has('r2')).toBe(true);
    expect(agentStore.sandboxBlockCount()).toBe(1);
  });

  it('clearSandboxBlock() drops the agent entry when its last block is cleared', () => {
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r1' }));
    agentStore.clearSandboxBlock('a1', 'r1');
    expect(agentStore.getState().sandboxBlocks.has('a1')).toBe(false);
    expect(agentStore.sandboxBlockCount()).toBe(0);
  });

  it('clearSandboxBlock() is a no-op for unknown agentId / requestId and does NOT notify listeners', () => {
    const listener = vi.fn();
    const unsub = agentStore.subscribe(listener);
    agentStore.clearSandboxBlock('nope', 'nope');
    expect(listener).not.toHaveBeenCalled();

    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r1' }));
    listener.mockClear();
    agentStore.clearSandboxBlock('a1', 'other-request');
    expect(listener).not.toHaveBeenCalled();
    unsub();
  });

  it('clearSandboxBlock() does NOT clobber blocks for other agents', () => {
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r1' }));
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a2', requestId: 'r1' }));
    agentStore.clearSandboxBlock('a1', 'r1');
    expect(agentStore.getState().sandboxBlocks.has('a1')).toBe(false);
    expect(agentStore.getState().sandboxBlocks.get('a2')?.has('r1')).toBe(true);
  });

  it('setSandboxBlock() and clearSandboxBlock() notify listeners', () => {
    const listener = vi.fn();
    const unsub = agentStore.subscribe(listener);
    agentStore.setSandboxBlock(makeBlock({ agentId: 'a1', requestId: 'r1' }));
    expect(listener).toHaveBeenCalledTimes(1);
    agentStore.clearSandboxBlock('a1', 'r1');
    expect(listener).toHaveBeenCalledTimes(2);
    unsub();
  });

  // -- Steps ------------------------------------------------------------------

  it('addStep() appends steps for an agent', () => {
    const step1: AgentStep = { toolCallId: 'tc1', label: 'Reading file', status: 'done' };
    const step2: AgentStep = { toolCallId: 'tc2', label: 'Writing file', status: 'running' };

    agentStore.addStep('a1', step1);
    expect(agentStore.getState().steps.get('a1')).toEqual([step1]);

    agentStore.addStep('a1', step2);
    expect(agentStore.getState().steps.get('a1')).toEqual([step1, step2]);
  });

  it('setSteps() replaces all steps for an agent', () => {
    const step1: AgentStep = { toolCallId: 'tc1', label: 'Old step', status: 'done' };
    agentStore.addStep('a1', step1);

    const newSteps: AgentStep[] = [
      { toolCallId: 'tc2', label: 'New step', status: 'running' },
    ];
    agentStore.setSteps('a1', newSteps);
    expect(agentStore.getState().steps.get('a1')).toEqual(newSteps);
  });

  // -- Presence ---------------------------------------------------------------

  it('setPresence() / clearPresence() manage the presence map', () => {
    const presence: AgentPresence = {
      agentId: 'a1',
      spaceId: 'i1',
      persona: { name: 'Agent Smith', handle: 'smith', color: '#ff0000' },
    };

    agentStore.setPresence('a1', presence);
    expect(agentStore.getState().presence.get('a1')).toEqual(presence);

    agentStore.clearPresence('a1');
    expect(agentStore.getState().presence.has('a1')).toBe(false);
  });

  it('clearPresence() is safe when agentId is not present', () => {
    agentStore.clearPresence('nonexistent');
    expect(agentStore.getState().presence.size).toBe(0);
  });

  // -- Yolo mode --------------------------------------------------------------

  it('setYoloMode(true) records the agent; setYoloMode(false) removes it', () => {
    agentStore.setYoloMode('a1', true);
    expect(agentStore.getState().yoloMode.get('a1')).toBe(true);

    agentStore.setYoloMode('a1', false);
    expect(agentStore.getState().yoloMode.has('a1')).toBe(false);
  });

  // -- Remote control ---------------------------------------------------------

  it('setRemoteState() with enabled=true records the agent', () => {
    agentStore.setRemoteState('a1', { enabled: true, url: 'https://x.example' });
    expect(agentStore.getState().remoteState.get('a1')).toEqual({ enabled: true, url: 'https://x.example' });
  });

  it('setRemoteState() with enabled=false removes the agent', () => {
    agentStore.setRemoteState('a1', { enabled: true, url: 'https://x.example' });
    agentStore.setRemoteState('a1', { enabled: false });
    expect(agentStore.getState().remoteState.has('a1')).toBe(false);
  });

  it('setRemoteState(null) removes the agent', () => {
    agentStore.setRemoteState('a1', { enabled: true });
    agentStore.setRemoteState('a1', null);
    expect(agentStore.getState().remoteState.has('a1')).toBe(false);
  });

  // -- Stale-fetch guards -----------------------------------------------------

  it('nextRequestId() returns monotonically increasing ids', () => {
    const id1 = agentStore.nextRequestId();
    const id2 = agentStore.nextRequestId();
    expect(id2).toBeGreaterThan(id1);
  });

  it('isCurrentRequest() recognizes only the latest reservation', () => {
    const stale = agentStore.nextRequestId();
    const fresh = agentStore.nextRequestId();

    expect(agentStore.isCurrentRequest(fresh)).toBe(true);
    expect(agentStore.isCurrentRequest(stale)).toBe(false);
  });

  // -- getAgentsBySpace() -----------------------------------------------------

  it('getAgentsBySpace() groups agents by space and skips workspace pseudo-space', () => {
    const a1 = makeAgent({ agentId: 'a1', spaceId: 'i1' });
    const a2 = makeAgent({ agentId: 'a2', spaceId: 'i1' });
    const a3 = makeAgent({ agentId: 'a3', spaceId: 'i2' });
    const a4 = makeAgent({ agentId: 'a4', spaceId: '__workspace__' });
    agentStore.setAgents([a1, a2, a3, a4]);

    const groups = agentStore.getAgentsBySpace();
    expect(groups.get('i1')).toEqual([a1, a2]);
    expect(groups.get('i2')).toEqual([a3]);
    expect(groups.has('__workspace__')).toBe(false);
  });

  // -- Subscribe / unsubscribe ------------------------------------------------

  it('subscribe() returns a working unsubscribe function', () => {
    const listener = vi.fn();
    const unsub = agentStore.subscribe(listener);

    agentStore.addProcessingIntent('i1');
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();

    agentStore.addProcessingIntent('i2');
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  it('multiple listeners are all notified', () => {
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    const unsub1 = agentStore.subscribe(listener1);
    const unsub2 = agentStore.subscribe(listener2);

    agentStore.addProcessingIntent('i1');

    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    unsub1();
    unsub2();
  });

  // -- getAgentsForIntent() ---------------------------------------------------

  it('getAgentsForIntent() returns filtered agents', () => {
    const a1 = makeAgent({ agentId: 'a1', spaceId: 'i1' });
    const a2 = makeAgent({ agentId: 'a2', spaceId: 'i2' });
    const a3 = makeAgent({ agentId: 'a3', spaceId: 'i1' });
    agentStore.setAgents([a1, a2, a3]);

    expect(agentStore.getAgentsForIntent('i1')).toEqual([a1, a3]);
    expect(agentStore.getAgentsForIntent('i2')).toEqual([a2]);
    expect(agentStore.getAgentsForIntent('i99')).toEqual([]);
  });

  // -- hasActiveAgent() -------------------------------------------------------

  it('hasActiveAgent() returns true for running agent', () => {
    agentStore.setAgents([makeAgent({ agentId: 'a1', spaceId: 'i1', status: 'running' })]);
    expect(agentStore.hasActiveAgent('i1')).toBe(true);
  });

  it('hasActiveAgent() returns true for waiting-approval agent', () => {
    agentStore.setAgents([makeAgent({ agentId: 'a1', spaceId: 'i1', status: 'waiting-approval' })]);
    expect(agentStore.hasActiveAgent('i1')).toBe(true);
  });

  it('hasActiveAgent() returns false for completed agent', () => {
    agentStore.setAgents([makeAgent({ agentId: 'a1', spaceId: 'i1', status: 'completed' })]);
    expect(agentStore.hasActiveAgent('i1')).toBe(false);
  });

  it('hasActiveAgent() returns false for failed agent', () => {
    agentStore.setAgents([makeAgent({ agentId: 'a1', spaceId: 'i1', status: 'failed' })]);
    expect(agentStore.hasActiveAgent('i1')).toBe(false);
  });

  it('hasActiveAgent() returns false when no agents match space', () => {
    agentStore.setAgents([makeAgent({ agentId: 'a1', spaceId: 'other' })]);
    expect(agentStore.hasActiveAgent('i1')).toBe(false);
  });

  // -- State immutability (spread on mutation) --------------------------------

  it('mutations produce new state objects', () => {
    const state1 = agentStore.getState();
    agentStore.addProcessingIntent('i1');
    const state2 = agentStore.getState();

    expect(state1).not.toBe(state2);
    expect(state1.processingSpaces.has('i1')).toBe(false);
    expect(state2.processingSpaces.has('i1')).toBe(true);
  });
});
