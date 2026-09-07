import { describe, expect, it, vi } from 'vitest';
import { equalPayload, reconcileByKey } from './reconcile';
import { spaceStore } from './space-store';
import { agentStore } from './agent-store';
import { historyStore } from './history-store';
import { skillStore } from './skill-store';
import { personaStore } from './persona-store';
import { canvasArtifactStore } from './canvas-artifact-store';
import type { Space } from '../../shared/types';
import type { AgentListAllItem } from '../../shared/ipc-contract';

describe('keyed snapshot reconciliation', () => {
  it('retains unchanged rows through payload cloning, reordering, insertion and removal', () => {
    const a = { id: 'a', metadata: { values: [1, null, 'value'] } };
    const b = { id: 'b', metadata: { values: [2] } };
    const previous = [a, b];
    const unchanged = reconcileByKey(previous, structuredClone(previous), row => row.id);
    expect(unchanged).toBe(previous);
    const incoming = [{ ...b, metadata: { values: [3] } }, structuredClone(a), { id: 'c', metadata: { values: [] } }];
    const changed = reconcileByKey(previous, incoming, row => row.id);
    expect(changed[0]).toBe(incoming[0]);
    expect(changed[1]).toBe(a);
    expect(changed[2]).toBe(incoming[2]);
    expect(reconcileByKey(changed, [structuredClone(a)], row => row.id)[0]).toBe(a);
  });

  it('does not treat missing, null, undefined, arrays and object values as interchangeable', () => {
    expect(equalPayload({}, { x: undefined })).toBe(false);
    expect(equalPayload({ x: null }, { x: undefined })).toBe(false);
    expect(equalPayload([1], { 0: 1 })).toBe(false);
    expect(equalPayload({ x: [1, 2] }, { x: [2, 1] })).toBe(false);
    expect(equalPayload({ x: 1, y: 2 }, { y: 2, x: 1 })).toBe(true);
  });

  it('preserves collection/store snapshots and avoids subscriber notifications for unchanged IPC payloads', () => {
    spaceStore.setSpaces(spaceStore.getState().spaces);
    personaStore.setPersonas(personaStore.getState().personas);
    const cases = [
      { get: () => spaceStore.getState(), set: () => spaceStore.setSpaces(structuredClone(spaceStore.getState().spaces)), subscribe: spaceStore.subscribe.bind(spaceStore) },
      { get: () => agentStore.getState(), set: () => agentStore.setAgents(structuredClone(agentStore.getState().agents)), subscribe: agentStore.subscribe.bind(agentStore) },
      { get: () => historyStore.getState(), set: () => historyStore.setEvents(structuredClone(historyStore.getState().events)), subscribe: historyStore.subscribe.bind(historyStore) },
      { get: () => skillStore.getState(), set: () => skillStore.setSkills(structuredClone(skillStore.getState().skills)), subscribe: skillStore.subscribe.bind(skillStore) },
      { get: () => personaStore.getState(), set: () => personaStore.setPersonas(structuredClone(personaStore.getState().personas)), subscribe: personaStore.subscribe.bind(personaStore) },
      { get: () => canvasArtifactStore.getState(), set: () => canvasArtifactStore.setArtifacts(structuredClone([...canvasArtifactStore.getState().bySpace.values()].flat())), subscribe: canvasArtifactStore.subscribe.bind(canvasArtifactStore) },
    ];
    for (const test of cases) {
      const before = test.get();
      const listener = vi.fn();
      const unsubscribe = test.subscribe(listener);
      test.set();
      expect(test.get()).toBe(before);
      expect(listener).not.toHaveBeenCalled();
      unsubscribe();
    }
  });

  it('distinguishes successful empty snapshots from resets and optimistic partial data', () => {
    spaceStore.reset();
    personaStore.reset();
    expect(spaceStore.getState().hydrated).toBe(false);
    expect(personaStore.getState().hydrated).toBe(false);
    spaceStore.setSpaces([]);
    personaStore.setPersonas([]);
    expect(spaceStore.getState().hydrated).toBe(true);
    expect(personaStore.getState().hydrated).toBe(true);
    spaceStore.reset();
    personaStore.reset();
  });

  it('keeps request reservations monotonic across resets', () => {
    for (const store of [spaceStore, agentStore, historyStore]) {
      const old = store.nextRequestId();
      store.reset();
      const next = store.nextRequestId();
      expect(next).toBeGreaterThan(old);
      expect(store.isCurrentRequest(old)).toBe(false);
    }
  });

  it('reconciles a 1000-row synthetic snapshot with stable identities and bounded notifications', () => {
    const spaces: Space[] = Array.from({ length: 1000 }, (_, index) => ({
      id: `s${index}`, description: `Synthetic ${index}`, body: null, raw_text: null,
      client: null, due_at: null, due_at_utc: null, recurrence: null,
      completed_at: null, folder: null, session_id: null, source_skill_id: null,
      attachments: [], status: 'captured', created_at: '', updated_at: '',
    }));
    const agents: AgentListAllItem[] = spaces.map(space => ({
      agentId: `a${space.id}`, spaceId: space.id, sessionId: space.id, status: 'running',
      summary: '', selectedText: '', quotedText: '', anchor: { quote: '', prefix: '', suffix: '' },
      createdAt: '', pendingApprovalId: null, pendingPermissionKind: null, pendingIntention: null,
      pendingPath: null, source: 'sdk', personaHandle: null, yoloMode: true,
      sandboxed: false, runLocation: 'local',
    }));
    spaceStore.setSpaces(spaces);
    agentStore.setAgents(agents, true);
    const spaceState = spaceStore.getState();
    const agentState = agentStore.getState();
    const listener = vi.fn();
    const stopSpaces = spaceStore.subscribe(listener);
    const stopAgents = agentStore.subscribe(listener);
    const samples: number[] = [];
    try {
      for (let i = 0; i < 30; i++) {
        const spacePayload = structuredClone(spaces);
        const agentPayload = structuredClone(agents);
        const start = performance.now();
        spaceStore.setSpaces(spacePayload);
        agentStore.setAgents(agentPayload, true);
        samples.push(performance.now() - start);
      }
      expect(spaceStore.getState()).toBe(spaceState);
      expect(agentStore.getState()).toBe(agentState);
      expect(listener).not.toHaveBeenCalled();
      agentStore.updateAgent('as500', { status: 'completed' });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(agentStore.getState().agents[499]).toBe(agents[499]);
      expect(agentStore.getState().agents[500].status).toBe('completed');
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
      console.info('[refresh fixture]', { spaces: spaces.length, agents: agents.length, samples: samples.length, p95Ms: p95, maxMs: sorted[sorted.length - 1] });
      expect(p95).toBeLessThan(50);
    } finally {
      stopSpaces();
      stopAgents();
      spaceStore.reset();
      agentStore.reset();
    }
  });
});
