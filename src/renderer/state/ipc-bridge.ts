/**
 * Sole owner of collection IPC reads. Legacy app.ts handlers still own canvas
 * presence, decorations and interaction UI, but mirror collection stores rather
 * than independently fetching the same lists.
 */
import { getReadAPI, type WhimAPI } from '../ipc-client';
import type { AgentListAllItem } from '../../shared/ipc-contract';
import { spaceStore } from './space-store';
import { agentStore } from './agent-store';
import { skillStore } from './skill-store';
import { historyStore } from './history-store';
import { personaStore } from './persona-store';
import { canvasArtifactStore } from './canvas-artifact-store';
import { RefreshCoordinator } from './refresh-coordinator';
import type { RefreshTiming } from './refresh-coordinator';

const REFRESH_DELAY_MS = 300;
type Collection = 'spaces' | 'agents' | 'active' | 'skills' | 'history' | 'personas' | 'artifacts';
interface BridgeOptions {
  isListVisible?: () => boolean;
}
interface SnapshotOptions {
  /** An explicit editor/settings action may need data without a visible list. */
  force?: boolean;
  /** Use after a mutation, not for concurrent readers of the same snapshot. */
  invalidate?: boolean;
  cursor?: string;
}
interface BridgeState {
  api: WhimAPI;
  visible: () => boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pending: Set<Collection>;
  workspace: boolean;
  wasVisible: boolean;
}
let state: BridgeState | null = null;
let coordinators = new WeakMap<WhimAPI, RefreshCoordinator>();
let historyLimits = new WeakMap<WhimAPI, number>();
let workspaceGeneration = 0;
let artifactFullRevision = 0;
let pagePositions = new WeakMap<WhimAPI, Map<string, { scope: string; cursor?: string }>>();
function pagePosition(api: WhimAPI, key: string, scope: string, options: SnapshotOptions): string | undefined {
  let positions = pagePositions.get(api);
  if (!positions) { positions = new Map(); pagePositions.set(api, positions); }
  const previous = positions.get(key);
  const cursor = 'cursor' in options ? options.cursor : previous?.scope === scope ? previous.cursor : undefined;
  return cursor;
}
function rememberPage(api: WhimAPI, key: string, scope: string, cursor?: string): void {
  pagePositions.get(api)?.set(key, { scope, cursor });
}
const artifactRevisions = new Map<string, number>();

export function getWorkspaceGeneration(): number {
  return workspaceGeneration;
}

/** In-memory IPC round-trip timings, with no IDs, paths, payloads or errors. */
export function getRefreshTimings(api: WhimAPI): RefreshTiming[] {
  return coordinator(api).getTimings();
}

function coordinator(api: WhimAPI): RefreshCoordinator {
  api = getReadAPI(api);
  let value = coordinators.get(api);
  if (!value) {
    value = new RefreshCoordinator(() => !state || state.api !== api || (state.workspace && state.visible()));
    coordinators.set(api, value);
  }
  return value;
}

function invalidate(api: WhimAPI, collections: Collection[]): void {
  for (const key of collections) coordinator(api).invalidate(key);
}

function consumePending(api: WhimAPI, ...collections: Collection[]): void {
  if (state?.api !== api) return;
  for (const key of collections) state.pending.delete(key);
}

function schedule(...collections: Collection[]): void {
  if (!state) return;
  invalidate(state.api, collections);
  for (const key of collections) state.pending.add(key);
  // Fixed window, not a sliding debounce: a continuous stream cannot starve it.
  if (state.timer || !state.visible() || !state.workspace) return;
  state.timer = setTimeout(() => {
    if (!state) return;
    state.timer = null;
    void flushPending();
  }, REFRESH_DELAY_MS);
}

async function flushPending(): Promise<void> {
  if (!state || !state.visible() || !state.workspace) return;
  const { api, pending } = state;
  state.pending = new Set();
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  const loads: Promise<void>[] = [];
  if (pending.has('spaces')) {
    loads.push(loadSpacesSnapshot(api));
  } else {
    if (pending.has('agents')) loads.push(loadAgentsSnapshot(api));
    if (pending.has('active')) loads.push(loadActiveSessions(api));
  }
  if (pending.has('skills')) loads.push(loadSkillsSnapshot(api));
  if (pending.has('history')) loads.push(loadHistorySnapshot(api));
  if (pending.has('personas')) loads.push(loadPersonasSnapshot(api));
  if (pending.has('artifacts') && !pending.has('spaces')) loads.push(loadCanvasArtifactsSnapshot(api));
  loads.push(coordinator(api).flush());
  // Explicit editor reads can join these flights and reject on failure. Each
  // resource reports its failure, and siblings still hydrate independently.
  await Promise.allSettled(loads);
}

/** Both native show and browser visibility use this path and share flights. */
export function refreshVisibleCollections(): Promise<void> {
  if (!state) return Promise.resolve();
  if (!state.visible() || !state.workspace) {
    state.wasVisible = false;
    return Promise.resolve();
  }
  if (!state.wasVisible) {
    state.wasVisible = true;
    state.pending.add('spaces');
    state.pending.add('artifacts');
    if (spaceStore.getState().filter === 'skills') state.pending.add('skills');
    if (spaceStore.getState().filter === 'closed') state.pending.add('history');
  }
  return flushPending();
}

export function installIpcBridge(api: WhimAPI, options: BridgeOptions = {}): void {
  if (state) return;
  api = getReadAPI(api);
  state = {
    api, visible: options.isListVisible ?? (() => true), timer: null,
    pending: new Set(), workspace: true, wasVisible: false,
  };
  api.onSpaceIndexChanged?.(data => {
    if (data.error) console.error('[search]', data.error);
    else schedule('spaces', 'history');
  });
  api.onSpaceDeleted?.(() => schedule('spaces', 'history'));

  api.onAgentApprovalNeeded(data => {
    agentStore.updateAgent(data.agentId, { status: 'waiting-approval' });
    agentStore.setApproval(data.agentId, {
      agentId: data.agentId, requestId: data.requestId,
      permissionKind: data.permissionKind || 'permission',
      intention: data.intention, path: data.path,
    });
    schedule('agents');
  });
  api.onAgentApprovalResolved?.(data => {
    if (agentStore.getState().approvals.get(data.agentId)?.requestId === data.requestId) {
      agentStore.clearApproval(data.agentId);
    }
    agentStore.nextRequestId();
    schedule('agents');
  });
  api.onAgentYoloChanged(data => {
    agentStore.setYoloMode(data.agentId, data.enabled);
    agentStore.updateAgent(data.agentId, { yoloMode: data.enabled });
    schedule('agents');
  });
  api.onAgentRemoteChanged(data => {
    agentStore.setRemoteState(data.agentId, { enabled: data.enabled, url: data.url });
  });
  api.onAgentPresenceStarted(data => {
    agentStore.setPresence(data.agentId, { agentId: data.agentId, spaceId: data.spaceId, persona: data.persona });
  });
  api.onAgentPresenceEnded(data => agentStore.clearPresence(data.agentId));
  api.onAgentStatusChanged(data => {
    if (data.status !== 'waiting-approval') agentStore.clearApproval(data.agentId);
    if (isAgentStatus(data.status)) {
      agentStore.updateAgent(data.agentId, {
        status: data.status,
        ...(data.summary === undefined ? {} : { summary: data.summary }),
      });
    }
    schedule('spaces', 'agents', 'active', 'history');
  });
  api.onAgentCompleted(data => {
    // The completion payload does not distinguish success from failure.
    if (data.summary !== undefined) agentStore.updateAgent(data.agentId, { summary: data.summary });
    schedule('spaces', 'agents', 'active', 'history');
  });
  api.onSpaceProcessed(id => {
    agentStore.removeProcessingIntent(id);
    schedule('spaces', 'agents', 'active', 'history');
  });
  api.onSpaceTitleUpdated(data => {
    spaceStore.updateSpaceTitle(data.spaceId, data.title);
    schedule('spaces', 'history');
  });
  api.onRecurrenceApplied(() => schedule('spaces', 'history'));
  api.onSkillsChanged(() => schedule('skills'));
  api.onCanvasArtifactPublished(data => {
    // Invalidate a full read too: it must not overwrite a newer keyed update.
    invalidate(api, ['artifacts']);
    coordinator(api).invalidate(`artifact:${data.spaceId}`);
    void loadSpaceArtifacts(api, data.spaceId);
  });
  api.onWorkspaceChanged(path => {
    workspaceGeneration += 1;
    artifactFullRevision += 1;
    artifactRevisions.clear();
    coordinator(api).reset();
    pagePositions.delete(api);
    if (state?.timer) clearTimeout(state.timer);
    if (state) {
      state.timer = null;
      state.pending.clear();
      state.workspace = !!path;
      state.wasVisible = false;
    }
    // Clear on A -> B as well as on disconnect; neither old rows nor late
    // snapshots may appear under the new workspace's actions.
    spaceStore.reset();
    agentStore.reset();
    skillStore.setSkills([]);
    skillStore.setSelectedSkill(null);
    historyStore.reset();
    personaStore.reset();
    canvasArtifactStore.clear();
    if (path) {
      schedule('spaces', 'skills', 'personas', 'artifacts', 'history');
      void flushPending();
    }
  });
}

function isAgentStatus(status: string): status is AgentListAllItem['status'] {
  return status === 'running' || status === 'waiting-approval' || status === 'completed' || status === 'failed';
}

export function loadSpacesSnapshot(api: WhimAPI, options: SnapshotOptions = {}): Promise<void> {
  api = getReadAPI(api);
  if (state?.api === api && state.visible() && state.workspace) state.wasVisible = true;
  consumePending(api, 'spaces', 'agents', 'active');
  if (options.invalidate) invalidate(api, ['spaces', 'agents', 'active']);
  const spaces = coordinator(api).request('spaces', async current => {
    const request = spaceStore.nextRequestId();
    const { filter, activeSearchQuery, searchMode } = spaceStore.getState();
    const cursor = pagePosition(api, 'spaces', `${filter}:${searchMode ? activeSearchQuery : ''}`, options);
    const result = await api.listSpacePage({
      filter: searchMode && activeSearchQuery ? 'all' : filter === 'closed' ? 'closed' : 'open', cursor,
      query: searchMode ? activeSearchQuery : undefined,
    });
    if (current() && spaceStore.isCurrentRequest(request)) {
      spaceStore.setPage(result);
      rememberPage(api, 'spaces', `${filter}:${searchMode ? activeSearchQuery : ''}`, cursor);
      await loadCanvasArtifactsSnapshot(api);
    }
  }, options.force || 'cursor' in options);
  if ('cursor' in options) return spaces;
  return Promise.all([spaces, loadActiveSessions(api, options), loadAgentsSnapshot(api, options)]).then(() => {});
}

function loadActiveSessions(api: WhimAPI, options: SnapshotOptions = {}): Promise<void> {
  return coordinator(api).request('active', async current => {
    const result = await api.getActiveSessions();
    if (current()) agentStore.setActiveSessionIntents(new Set(result));
  }, options.force);
}

export function loadAgentsSnapshot(api: WhimAPI, options: SnapshotOptions = {}): Promise<void> {
  api = getReadAPI(api);
  consumePending(api, 'agents');
  if (options.invalidate) invalidate(api, ['agents']);
  return coordinator(api).request('agents', async current => {
    const request = agentStore.nextRequestId();
    const { searchMode, activeSearchQuery } = spaceStore.getState();
    const cursor = pagePosition(api, 'agents', searchMode ? activeSearchQuery : '', options);
    const page = await api.listAgentPage({ cursor, query: searchMode ? activeSearchQuery : undefined });
    if (!current() || !agentStore.isCurrentRequest(request)
      || searchMode !== spaceStore.getState().searchMode
      || activeSearchQuery !== spaceStore.getState().activeSearchQuery) return;
    agentStore.setPage(page);
    rememberPage(api, 'agents', searchMode ? activeSearchQuery : '', cursor);
  }, options.force || 'cursor' in options);
}

export function loadSkillsSnapshot(api: WhimAPI, options: SnapshotOptions = {}): Promise<void> {
  api = getReadAPI(api);
  consumePending(api, 'skills');
  if (options.invalidate) invalidate(api, ['skills']);
  return coordinator(api).request('skills', async current => {
    const result = await api.listSkills();
    if (current()) skillStore.setSkills(result);
  }, options.force);
}

export function loadPersonasSnapshot(api: WhimAPI, options: SnapshotOptions = {}): Promise<void> {
  api = getReadAPI(api);
  consumePending(api, 'personas');
  if (options.invalidate) invalidate(api, ['personas']);
  return coordinator(api).request('personas', async current => {
    const result = await api.listPersonas();
    if (current()) personaStore.setPersonas(result || []);
  }, options.force);
}

export function loadHistorySnapshot(api: WhimAPI, limit = 60, options: SnapshotOptions = {}): Promise<void> {
  api = getReadAPI(api);
  consumePending(api, 'history');
  if (options.invalidate) invalidate(api, ['history']);
  const previousLimit = historyLimits.get(api);
  if (previousLimit !== undefined && previousLimit !== limit) invalidate(api, ['history']);
  historyLimits.set(api, limit);
  return coordinator(api).request('history', async current => {
    const request = historyStore.nextRequestId();
    const cursor = pagePosition(api, 'history', 'activity', options);
    const page = await api.listActivityPage({ cursor, limit: Math.min(100, limit) });
    if (current() && historyStore.isCurrentRequest(request)) {
      historyStore.setPage(page);
      rememberPage(api, 'history', 'activity', cursor);
    }
  }, options.force || 'cursor' in options);
}

export function loadCanvasArtifactsSnapshot(api: WhimAPI): Promise<void> {
  api = getReadAPI(api);
  consumePending(api, 'artifacts');
  return coordinator(api).request('artifacts', async current => {
    artifactFullRevision += 1;
    const revisions = new Map(artifactRevisions);
    const { artifacts } = await api.listAllCanvasArtifacts(spaceStore.getState().spaces.map(space => space.id));
    if (!current()) return;
    const newerSpaces = new Set([...artifactRevisions.keys()]
      .filter(id => artifactRevisions.get(id) !== revisions.get(id)));
    const reconciled = artifacts.filter(artifact => !newerSpaces.has(artifact.spaceId));
    for (const id of newerSpaces) reconciled.push(...canvasArtifactStore.getSpaceArtifacts(id));
    canvasArtifactStore.setArtifacts(reconciled);
  });
}

export function loadSpaceArtifacts(api: WhimAPI, spaceId: string, force = false): Promise<void> {
  api = getReadAPI(api);
  return coordinator(api).request(`artifact:${spaceId}`, async current => {
    const fullRevision = artifactFullRevision;
    artifactRevisions.set(spaceId, (artifactRevisions.get(spaceId) ?? 0) + 1);
    const { artifacts } = await api.listCanvasArtifacts(spaceId);
    if (current() && fullRevision === artifactFullRevision) canvasArtifactStore.setSpaceArtifacts(spaceId, artifacts);
  }, force);
}

export async function openCanvasArtifact(api: WhimAPI, spaceId: string, artifactId: string): Promise<void> {
  const generation = workspaceGeneration;
  try {
    const result = await api.openCanvasArtifact(spaceId, artifactId);
    if (generation === workspaceGeneration && result && 'error' in result && result.error) {
      await loadSpaceArtifacts(api, spaceId, true);
    }
  } catch {
    console.error('[refresh] artifact open failed');
    if (generation === workspaceGeneration) await loadSpaceArtifacts(api, spaceId, true);
  }
}

export async function refreshSpaceActivity(api: WhimAPI): Promise<void> {
  await Promise.all([
    loadSpacesSnapshot(api, { invalidate: true }),
    loadHistorySnapshot(api, 60, { invalidate: true }),
  ]);
}

export async function restoreSpace(api: WhimAPI, spaceId: string) {
  const result = await api.unarchive(spaceId);
  if (result) await refreshSpaceActivity(api);
  return result;
}

export function _resetIpcBridgeForTests(): void {
  if (state) {
    if (state.timer) clearTimeout(state.timer);
    coordinator(state.api).reset();
  }
  state = null;
  coordinators = new WeakMap();
  pagePositions = new WeakMap();
  historyLimits = new WeakMap();
  workspaceGeneration += 1;
  artifactFullRevision += 1;
  artifactRevisions.clear();
}
