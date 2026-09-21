// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRow } from '../../shared/activity-types';
import type { AgentListAllItem } from '../../shared/ipc-contract';
import type { Space } from '../../shared/types';
import type { ActivityPageRequest, AgentPageRequest, SpacePageRequest } from '../../shared/paging';
import { getAPI, type WhimAPI } from '../ipc-client';
import { trackSettingWrites } from '../save-lifecycle';
import { spaceStore } from '../state/space-store';
import { agentStore } from '../state/agent-store';
import { historyStore } from '../state/history-store';
import {
  _resetIpcBridgeForTests, installIpcBridge, loadSpacesSnapshot, loadAgentsSnapshot,
  loadHistorySnapshot, refreshVisibleCollections, restoreSpace, getRefreshTimings,
} from '../state/ipc-bridge';
import { HistoryView } from './HistoryView';

function fixture() {
  let indexChanged!: Parameters<WhimAPI['onSpaceIndexChanged']>[0];
  let agentChanged!: Parameters<WhimAPI['onAgentStatusChanged']>[0];
  const restored = new Set<string>();
  const space = (id: string): Space => ({
    id, description: id, body: null, raw_text: null, client: null, due_at: null, due_at_utc: null,
    recurrence: null, completed_at: restored.has(id) ? null : '2026-09-10T12:00:00Z',
    folder: null, session_id: null, source_skill_id: null, attachments: [],
    status: restored.has(id) ? 'captured' : 'done', created_at: '2026-09-09T12:00:00Z', updated_at: '2026-09-10T12:00:00Z',
  });
  const row = (id: string): ActivityRow => ({
    key: `${restored.has(id) ? 'event' : 'space'}-${id}`,
    kind: restored.has(id) ? 'event' : 'space', spaceId: restored.has(id) ? null : id,
    title: id, at: Date.parse('2026-09-10T12:00:00Z'), icon: '', variant: 'completed',
    client: null, agentCount: 0, hasSession: false, duration: '', rescheduled: 0,
  });
  const agent = (agentId: string): AgentListAllItem => ({
    agentId, sessionId: agentId, spaceId: 'later-note', status: 'completed', summary: '',
    selectedText: '', quotedText: '', anchor: { quote: '', prefix: '', suffix: '' },
    createdAt: '', pendingApprovalId: null, pendingPermissionKind: null,
    pendingIntention: null, pendingPath: null, source: 'sdk', personaHandle: null,
    yoloMode: false, sandboxed: false, runLocation: 'local',
  });
  const raw = Object.freeze({
    listSpacePage: vi.fn(async (request: SpacePageRequest = {}) => {
      const id = request.cursor ? 'later-note' : 'first-note';
      return { items: restored.has(id) ? [] : [space(id)], total: 4, nextCursor: request.cursor ? null : 'NEXT',
        offset: request.cursor ? 2 : 0, counts: { open: restored.size, closed: 4 - restored.size } };
    }),
    listAgentPage: vi.fn(async (request: AgentPageRequest = {}) => ({
      items: [agent(request.cursor ? 'later-worker' : 'first-worker')], total: 4,
      nextCursor: request.cursor ? null : 'NEXT', offset: request.cursor ? 2 : 0,
      counts: { running: 0, waiting: 0, completed: 4, failed: 0 },
    })),
    listActivityPage: vi.fn(async (request: ActivityPageRequest = {}) => ({
      items: [row(request.cursor ? 'later-note' : 'first-note')], total: 4,
      nextCursor: request.cursor ? null : 'NEXT', offset: request.cursor ? 2 : 0,
    })),
    getActiveSessions: vi.fn().mockResolvedValue([]),
    listAllCanvasArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
    listCanvasArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
    setSetting: vi.fn().mockResolvedValue(null),
    unarchive: vi.fn(async (id: string) => { restored.add(id); return space(id); }),
    onSpaceIndexChanged: (callback: typeof indexChanged) => { indexChanged = callback; },
    onAgentStatusChanged: (callback: typeof agentChanged) => { agentChanged = callback; },
    onAgentApprovalNeeded: vi.fn(), onAgentApprovalResolved: vi.fn(),
    onAgentYoloChanged: vi.fn(), onAgentRemoteChanged: vi.fn(),
    onAgentPresenceStarted: vi.fn(), onAgentPresenceEnded: vi.fn(),
    onAgentCompleted: vi.fn(), onSpaceProcessed: vi.fn(), onSpaceTitleUpdated: vi.fn(),
    onRecurrenceApplied: vi.fn(), onSkillsChanged: vi.fn(),
    onCanvasArtifactPublished: vi.fn(), onWorkspaceChanged: vi.fn(), onSpaceDeleted: vi.fn(),
  });
  const partial: Partial<WhimAPI> = raw;
  const api = partial as WhimAPI;
  vi.stubGlobal('whimAPI', api);
  const tracked = trackSettingWrites(api);
  return { api, raw, tracked, fireIndex: () => indexChanged({}),
    fireAgent: () => agentChanged({ agentId: 'worker', status: 'completed' }) };
}

let root: Root | undefined;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  _resetIpcBridgeForTests();
  spaceStore.reset();
  agentStore.reset();
  historyStore.reset();
  spaceStore.setFilter('closed');
  container = document.createElement('div');
  document.body.append(container);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container.remove();
  _resetIpcBridgeForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('tracked desktop reads and live activity', () => {
  it('shares diagnostics and history query limits across tracked and raw API identities', async () => {
    const { api, raw, tracked } = fixture();
    installIpcBridge(tracked.api);
    expect(getRefreshTimings(tracked.api)).toEqual([]);
    expect(raw.listActivityPage).not.toHaveBeenCalled();
    let finish!: () => void;
    raw.listActivityPage.mockImplementationOnce(() => new Promise(resolve => {
      finish = () => resolve({ items: [], total: 0, nextCursor: null, offset: 0 });
    }));
    const first = loadHistorySnapshot(tracked.api, 20);
    const expanded = loadHistorySnapshot(api, 60);
    expect(raw.listActivityPage).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, expanded]);
    expect(raw.listActivityPage.mock.calls.map(([request]) => request?.limit)).toEqual([20, 60]);
    const timings = getRefreshTimings(api);
    expect(timings).toEqual([expect.objectContaining({ collection: 'history', requests: 2, failures: 0 })]);
    expect(getRefreshTimings(tracked.api)).toEqual(timings);
    expect(raw.listActivityPage).toHaveBeenCalledTimes(2);
  });

  it('shares flights and page cursors across the shell tracker, React API, events and visibility', async () => {
    const { api, raw, tracked, fireIndex, fireAgent } = fixture();
    let visible = true;
    installIpcBridge(tracked.api, { isListVisible: () => visible });
    expect(getAPI()).toBe(api);
    expect(tracked.api).not.toBe(api);
    await Promise.all([
      loadSpacesSnapshot(tracked.api), loadSpacesSnapshot(getAPI()),
      loadHistorySnapshot(tracked.api), loadHistorySnapshot(getAPI()),
    ]);
    expect(raw.listSpacePage).toHaveBeenCalledTimes(1);
    expect(raw.listAgentPage).toHaveBeenCalledTimes(1);
    expect(raw.listActivityPage).toHaveBeenCalledTimes(1);
    await Promise.all([
      loadSpacesSnapshot(getAPI(), { cursor: 'NEXT', invalidate: true }),
      loadAgentsSnapshot(getAPI(), { cursor: 'NEXT', invalidate: true }),
      loadHistorySnapshot(getAPI(), 60, { cursor: 'NEXT', invalidate: true }),
    ]);
    fireIndex();
    fireAgent();
    await vi.advanceTimersByTimeAsync(300);
    for (const read of [raw.listSpacePage, raw.listAgentPage, raw.listActivityPage]) {
      expect(read.mock.calls.map(([request]) => request?.cursor)).toEqual([undefined, 'NEXT', 'NEXT']);
    }
    expect(spaceStore.getState().page?.offset).toBe(2);
    expect(agentStore.getState().page?.offset).toBe(2);
    expect(historyStore.getState().page?.offset).toBe(2);

    visible = false;
    await refreshVisibleCollections();
    fireIndex();
    fireAgent();
    await Promise.all([loadSpacesSnapshot(getAPI()), loadHistorySnapshot(getAPI())]);
    await vi.advanceTimersByTimeAsync(300);
    expect(raw.listSpacePage).toHaveBeenCalledTimes(3);
    expect(raw.listAgentPage).toHaveBeenCalledTimes(3);
    expect(raw.listActivityPage).toHaveBeenCalledTimes(3);
    visible = true;
    await refreshVisibleCollections();
    for (const read of [raw.listSpacePage, raw.listAgentPage, raw.listActivityPage]) {
      expect(read.mock.calls.map(([request]) => request?.cursor)).toEqual([undefined, 'NEXT', 'NEXT', 'NEXT']);
    }
    expect(spaceStore.getState().spaces.map(space => space.id)).toEqual(['later-note']);
    expect(agentStore.getState().agents.map(agent => agent.agentId)).toEqual(['later-worker']);
    expect(historyStore.getState().page?.items.map(row => row.key)).toEqual(['space-later-note']);
    await tracked.api.setSetting('theme', 'dark');
    expect(raw.setSetting).toHaveBeenCalledExactlyOnceWith('theme', 'dark');
    await expect(tracked.flush()).resolves.toBeUndefined();
  });

  it.each(['local restore', 'remote index event'])('updates a real History row after %s without resetting its page', async source => {
    const { raw, tracked, fireIndex } = fixture();
    installIpcBridge(tracked.api);
    await loadHistorySnapshot(tracked.api);
    let restore: Promise<unknown> | undefined;
    root = createRoot(container);
    await act(async () => root!.render(<HistoryView onCardClick={vi.fn()}
      onUnarchive={id => { restore = restoreSpace(tracked.api, id); }} />));
    await act(async () => container.querySelector<HTMLButtonElement>('.list-navigation button')!.click());
    expect(raw.listActivityPage).toHaveBeenLastCalledWith({ cursor: 'NEXT', limit: 60 });
    expect(container.querySelector('[data-id="later-note"]')).not.toBeNull();
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Restore later-note to Spaces"]')!;
    expect(button).not.toBeNull();
    if (source === 'local restore') {
      await act(async () => { button.click(); await restore; });
    } else {
      await act(async () => {
        await raw.unarchive('later-note');
        fireIndex();
        await vi.advanceTimersByTimeAsync(300);
      });
    }
    expect(raw.unarchive).toHaveBeenCalledExactlyOnceWith('later-note');
    expect(container.querySelector('[aria-label="Restore later-note to Spaces"]')).toBeNull();
    expect(container.querySelector('[data-virtual-id="event-later-note"]')).not.toBeNull();
    expect(historyStore.getState().page?.offset).toBe(2);
    expect(raw.listActivityPage.mock.calls.map(([request]) => request?.cursor)).toEqual([undefined, 'NEXT', 'NEXT']);
    expect(container.querySelector('.list-navigation button')?.textContent).toBe('Previous');
  });
});
