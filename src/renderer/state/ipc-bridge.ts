/**
 * IPC -> store bridge.
 *
 * Translates renderer IPC events into mutations on the typed stores
 * (space-store, agent-store, skill-store, history-store, persona-store).
 *
 * Why this exists:
 *   The legacy `src/renderer/app.ts` reacts to IPC events by mutating
 *   module-level state and writing imperative HTML via `innerHTML`. As
 *   the four main lists migrate to React, components subscribe to the
 *   stores via `useSyncExternalStore` and need a single, consistent place
 *   where IPC events flow into store state.
 *
 * Migration policy:
 *   During the migration this bridge runs *alongside* the legacy
 *   app.ts subscribers. The duplicate work is intentional and short-
 *   lived: once Phase 6 mounts the React lists, the legacy IPC handlers
 *   for these concerns are removed from app.ts and the bridge becomes
 *   the only path.
 *
 * Atomicity:
 *   Snapshot loaders (`loadSpacesSnapshot`, etc.) use the
 *   `nextRequestId` / `isCurrentRequest` helpers on each store to drop
 *   stale results when newer reservations are made — replaces the
 *   legacy `app.ts:renderGeneration` token.
 */

import type { WhimAPI } from '../ipc-client';
import { spaceStore } from './space-store';
import { agentStore } from './agent-store';
import { skillStore } from './skill-store';
import { historyStore } from './history-store';
import { personaStore } from './persona-store';
import { canvasArtifactStore } from './canvas-artifact-store';

let installed = false;

const AGENT_REFRESH_DELAY_MS = 300;

interface BridgeState {
  api: WhimAPI;
  agentSnapshotTimer: ReturnType<typeof setTimeout> | null;
  spaceSnapshotTimer: ReturnType<typeof setTimeout> | null;
}

let state: BridgeState | null = null;

function scheduleSpacesSnapshot(): void {
  if (!state) return;
  if (state.spaceSnapshotTimer) clearTimeout(state.spaceSnapshotTimer);
  state.spaceSnapshotTimer = setTimeout(() => {
    if (!state) return;
    state.spaceSnapshotTimer = null;
    void loadSpacesSnapshot(state.api);
  }, AGENT_REFRESH_DELAY_MS);
}

function scheduleAgentsSnapshot(): void {
  if (!state) return;
  if (state.agentSnapshotTimer) clearTimeout(state.agentSnapshotTimer);
  state.agentSnapshotTimer = setTimeout(() => {
    if (!state) return;
    state.agentSnapshotTimer = null;
    void loadAgentsSnapshot(state.api);
  }, AGENT_REFRESH_DELAY_MS);
}

/**
 * Subscribe to all list-affecting IPC events and route them to the stores.
 *
 * Idempotent: calling this more than once is a no-op (returns silently).
 * Subscriptions live for the lifetime of the renderer process — the
 * preload API does not return unsubscribers for these channels.
 */
export function installIpcBridge(api: WhimAPI): void {
  if (installed) return;
  installed = true;
  state = { api, agentSnapshotTimer: null, spaceSnapshotTimer: null };

  // -- Pure store mutations from event payloads -----------------------------

  api.onAgentApprovalNeeded((data) => {
    agentStore.setApproval(data.agentId, {
      agentId: data.agentId,
      requestId: data.requestId,
      permissionKind: data.permissionKind || 'permission',
      intention: data.intention,
      path: data.path,
    });
  });

  api.onAgentYoloChanged((data) => {
    agentStore.setYoloMode(data.agentId, data.enabled);
  });

  api.onAgentRemoteChanged((data) => {
    agentStore.setRemoteState(data.agentId, { enabled: data.enabled, url: data.url });
  });

  api.onAgentPresenceStarted((data) => {
    agentStore.setPresence(data.agentId, {
      agentId: data.agentId,
      spaceId: data.spaceId,
      persona: data.persona,
    });
  });

  api.onAgentPresenceEnded((data) => {
    agentStore.clearPresence(data.agentId);
  });

  // -- Status/completion: clear approval + debounced refetch ----------------

  api.onAgentStatusChanged((data) => {
    if (data.status !== 'waiting-approval') {
      agentStore.clearApproval(data.agentId);
    }
    scheduleAgentsSnapshot();
    scheduleSpacesSnapshot();
  });

  api.onAgentCompleted(() => {
    scheduleAgentsSnapshot();
    scheduleSpacesSnapshot();
  });

  // -- Space/recurrence/skill changes: refetch the relevant snapshot -------

  api.onSpaceProcessed(() => {
    scheduleSpacesSnapshot();
  });

  api.onSpaceTitleUpdated((data) => {
    spaceStore.updateSpaceTitle(data.spaceId, data.title);
    scheduleSpacesSnapshot();
  });

  api.onRecurrenceApplied(() => {
    scheduleSpacesSnapshot();
  });

  api.onSkillsChanged(() => {
    void loadSkillsSnapshot(api);
  });

  api.onCanvasArtifactPublished((data) => {
    // Refresh just the affected space: a republish elsewhere should not make
    // every chip in the list flicker.
    void loadSpaceArtifacts(api, data.spaceId);
  });

  api.onWorkspaceChanged((path) => {
    if (path) {
      void loadSpacesSnapshot(api);
      void loadSkillsSnapshot(api);
      void loadPersonasSnapshot(api);
      void loadCanvasArtifactsSnapshot(api);
    } else {
      spaceStore.setSpaces([]);
      agentStore.reset();
      skillStore.setSkills([]);
      historyStore.reset();
      personaStore.setPersonas([]);
      canvasArtifactStore.clear();
    }
  });
}

/**
 * Atomic loader: fetches spaces, active sessions, and all agents in parallel,
 * then applies the combined snapshot to the relevant stores. Each result is
 * gated by its OWN store's request id so a concurrent agents-only refresh
 * can't invalidate a still-fresh spaces result, and vice versa.
 *
 * Replaces the sequential `await api.list(); await api.getActiveSessions();
 * await api.listAllAgents()` chain in the legacy `loadSpaces()` body.
 */
export async function loadSpacesSnapshot(api: WhimAPI): Promise<void> {
  const spaceReq = spaceStore.nextRequestId();
  const agentReq = agentStore.nextRequestId();

  const [spacesResult, activeResult, agentsResult] = await Promise.allSettled([
    api.list(),
    api.getActiveSessions(),
    api.listAllAgents(),
  ]);

  // Apply each result independently. A racing agents-only refresh that bumps
  // agentStore's request id must NOT prevent fresh space results from landing.
  if (spacesResult.status === 'fulfilled' && spaceStore.isCurrentRequest(spaceReq)) {
    spaceStore.setSpaces(spacesResult.value);
  }
  if (agentStore.isCurrentRequest(agentReq)) {
    if (activeResult.status === 'fulfilled') {
      agentStore.setActiveSessionIntents(new Set(activeResult.value));
    }
    if (agentsResult.status === 'fulfilled') {
      agentStore.setAgents(agentsResult.value);
    }
  }
}

/** Refresh just the agents collection (used by status/completion events). */
export async function loadAgentsSnapshot(api: WhimAPI): Promise<void> {
  const req = agentStore.nextRequestId();
  try {
    const agents = await api.listAllAgents();
    if (agentStore.isCurrentRequest(req)) {
      agentStore.setAgents(agents);
    }
  } catch {
    // ignore — leave existing agents in place
  }
}

/** Load every published artifact across the spaces the user has not completed. */
export async function loadCanvasArtifactsSnapshot(api: WhimAPI): Promise<void> {
  try {
    const { artifacts } = await api.listAllCanvasArtifacts();
    canvasArtifactStore.setArtifacts(artifacts);
  } catch {
    // ignore — leave the existing index in place
  }
}

/** Refresh one space's artifacts, e.g. after a run publishes. */
export async function loadSpaceArtifacts(api: WhimAPI, spaceId: string): Promise<void> {
  try {
    const { artifacts } = await api.listCanvasArtifacts(spaceId);
    canvasArtifactStore.setSpaceArtifacts(spaceId, artifacts);
  } catch {
    // ignore — leave the existing entry in place
  }
}

/**
 * Open a report, and drop its chip if the file is no longer on disk.
 *
 * The chip is drawn from a snapshot, and reports live in the workspace, so git
 * sync or a manual delete can remove one out from under it. Without this the
 * chip is simply inert when clicked, which reads as whim being broken.
 */
export async function openCanvasArtifact(api: WhimAPI, spaceId: string, artifactId: string): Promise<void> {
  try {
    const result = await api.openCanvasArtifact(spaceId, artifactId);
    if (result && 'error' in result && result.error) {
      await loadSpaceArtifacts(api, spaceId);
    }
  } catch {
    await loadSpaceArtifacts(api, spaceId);
  }
}

export async function loadSkillsSnapshot(api: WhimAPI): Promise<void> {
  try {
    const skills = await api.listSkills();
    skillStore.setSkills(skills);
  } catch {
    // ignore — leave existing skills in place
  }
}

export async function loadHistorySnapshot(api: WhimAPI, limit = 200): Promise<void> {
  const req = historyStore.nextRequestId();
  try {
    const events = await api.listEvents(limit);
    if (historyStore.isCurrentRequest(req)) {
      historyStore.setEvents(events);
    }
  } catch {
    // ignore
  }
}

export async function loadPersonasSnapshot(api: WhimAPI): Promise<void> {
  try {
    const personas = await api.listPersonas();
    personaStore.setPersonas(personas || []);
  } catch {
    // ignore
  }
}

// -- Test helpers -----------------------------------------------------------

/** Test-only: reset the install guard so a test suite can re-install. */
export function _resetIpcBridgeForTests(): void {
  if (state) {
    if (state.agentSnapshotTimer) clearTimeout(state.agentSnapshotTimer);
    if (state.spaceSnapshotTimer) clearTimeout(state.spaceSnapshotTimer);
  }
  state = null;
  installed = false;
}
