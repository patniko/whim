import { AgentAnchor, AgentSession, CanvasAgent, CanvasAgentStateSnapshot } from '../shared/types';
import { SubagentTracker } from './subagent-service';
import { AgentRegistry } from './agents/agent-registry';
import type { AgentRecord } from './agents/agent-registry';
import { AgentNotifier } from './agents/agent-notifier';
import { AgentPersistence } from './agents/agent-persistence';
import { InteractionBroker } from './agents/interaction-broker';
import { deleteAgentSession, listAllRunningAgents, updateCanvasAgentStatus, listAgentSummaries, getAgentSession, listAgentSessions, listAgentHistoryPage, isInitialized } from './storage';
import type { AgentPageRequest, AgentPage, PageRequest, ChatHistoryPage } from '../shared/paging';
import type { AgentSummaryRow } from './paged-queries';
import { pageLimit, encodeCursor, decodeCursor } from './paged-queries';
import { subscribeWebRemoteEvents } from './web/event-hub';

// Import runner modules
import { initSdkRunner, setupAgentEventListeners, finishScheduledAgent, resumeAgentSession } from './agents/sdk-runner';
import { loadRuntimeHistoryPage } from './agents/runtime-history-loader';
import { initCliRunner } from './agents/cli-runner';
import { initCommentWorkflow } from './agents/comment-workflow';
import { releaseCanvasInstances } from './canvas/canvas-lifecycle';
import { endCanvasRun } from './canvas/canvas-outcome';
import { RESTART_INTERRUPTION_SUMMARY } from './services/scheduled-run-recovery';

export type { AgentStatus } from './agents/agent-registry';

type AgentListSnapshot = {
  agentId: string;
  sessionId: string;
  status: import('./agents/agent-registry').AgentStatus;
  summary: string;
  selectedText: string;
  quotedText: string;
  anchor: AgentAnchor;
  spaceId: string;
  createdAt: string;
  pendingApprovalId: string | null;
  pendingPermissionKind: string | null;
  pendingIntention: string | null;
  pendingPath: string | null;
  source: 'sdk' | 'cli' | 'cca';
  personaHandle: string | null;
  yoloMode: boolean;
  sandboxed: boolean;
  runLocation: 'local' | 'cloud';
};

function fallbackAnchor(quote: string): AgentAnchor {
  return { quote, prefix: '', suffix: '' };
}

// ── Shared state ───────────────────────────────────────
const registry = new AgentRegistry();
const notifier = new AgentNotifier();
const persistence = new AgentPersistence();
const broker = new InteractionBroker(notifier, persistence);

export const subagentTracker = new SubagentTracker();

// Broadcast sub-agent changes to renderer
subagentTracker.onChange((parentAgentId) => {
  notifier.notifyRenderer(`subagent:changed:${parentAgentId}`);
});

// ── Initialize runner modules with shared deps ─────────
initSdkRunner({ registry, notifier, persistence, broker, subagentTracker });
initCliRunner({ registry, notifier, persistence });
initCommentWorkflow({ registry, notifier, persistence, broker, setupAgentEventListeners });

// ── Re-exports from SDK runner ─────────────────────────
export { buildCliToolsPrompt, launchAgent, launchQuickAgent, launchDocumentAgent, sendChatMessage, setAgentModel, getAgentHistory, enableRemoteControl, disableRemoteControl, getRemoteState, resetRemoteControl, disableSandboxForSession } from './agents/sdk-runner';

// ── App-level remote control ──────────────────────────

/**
 * Reconcile shared state for the app-level remote-control flow.  Exported only
 * for tests so the in-flight guard can be reset between cases.
 */
type AppRemoteResult = { enabled: boolean; agents: Array<{ agentId: string; url?: string }> } | { error: string };

let appRemoteInFlight: Promise<AppRemoteResult> | null = null;

function findRemoteSupervisor() {
  for (const record of registry.values()) {
    if (
      record.appRemoteSupervisor === true &&
      (record.status === 'running' || record.status === 'waiting-approval')
    ) {
      return record;
    }
  }
  return undefined;
}

/**
 * Enable or disable app-level remote for all active SDK workspace-level agents.
 *
 * `setAppRemote(true)` is idempotent — it acts as a reconciliation function:
 *   1. If a healthy supervisor with a remote URL already exists, reuse it.
 *   2. Else if a healthy supervisor exists without a URL, retry enabling
 *      remote on it (don't launch a duplicate worker).
 *   3. Else launch a new supervisor agent and enable remote on it.
 *
 * Concurrent calls share the same in-flight promise to avoid spawning
 * duplicate supervisors from rapid clicks or multiple entry points (UI,
 * tray menu, etc.).  Persists `remoteEnabled` and fires `app:remote-changed`.
 */
export async function setAppRemote(enabled: boolean): Promise<AppRemoteResult> {
  // Coalesce concurrent calls so multiple entry points (UI + tray + double
  // click) cannot each spawn a workspace supervisor.
  if (appRemoteInFlight) {
    return appRemoteInFlight;
  }
  const p = doSetAppRemote(enabled).finally(() => {
    appRemoteInFlight = null;
  });
  appRemoteInFlight = p;
  return p;
}

async function doSetAppRemote(enabled: boolean): Promise<AppRemoteResult> {
  const { setConfigValue, getConfigValue } = await import('./config');
  setConfigValue('remoteEnabled', enabled);

  const { enableRemoteControl, disableRemoteControl, launchQuickAgent } = await import('./agents/sdk-runner');
  const agents: Array<{ agentId: string; url?: string }> = [];

  if (enabled) {
    // ── Reconcile: find or create the dedicated supervisor ────────────
    let supervisor = findRemoteSupervisor();

    if (supervisor && supervisor.remote?.enabled && supervisor.remote.url) {
      // (1) Healthy supervisor with URL — reuse it.
      console.log(`[agent-service] Reusing existing remote supervisor: agentId=${supervisor.agentId}`);
      agents.push({ agentId: supervisor.agentId, url: supervisor.remote.url });
    } else if (supervisor) {
      // (2) Supervisor exists without a URL — retry enabling remote on it.
      console.log(`[agent-service] Retrying remote enable on existing supervisor: agentId=${supervisor.agentId}`);
      agents.push({ agentId: supervisor.agentId });
      try {
        const remoteResult = await Promise.race([
          enableRemoteControl(supervisor.agentId),
          new Promise<{ error: string }>(resolve =>
            setTimeout(() => resolve({ error: 'Timed out waiting for remote URL' }), 10_000)
          ),
        ]);
        if ('url' in remoteResult && remoteResult.url) {
          agents[agents.length - 1].url = remoteResult.url;
        } else if ('error' in remoteResult) {
          console.error(`[agent-service] enableRemoteControl retry error:`, remoteResult.error);
        }
      } catch (err: any) {
        console.error(`[agent-service] enableRemoteControl retry threw:`, err);
      }
    } else {
      // (3) No supervisor — launch a new one and enable remote on it.
      const workspace = getConfigValue('workspace') || process.cwd();
      console.log(`[agent-service] Launching workspace management agent in: ${workspace}`);
      const launchResult = await launchQuickAgent(
        'You are the remote management assistant for this workspace. Help the user manage their spaces and workers. Start by listing the current spaces and any active workers.',
        workspace,
      );
      if ('error' in launchResult) {
        console.error(`[agent-service] launchQuickAgent FAILED:`, launchResult.error);
      } else {
        console.log(`[agent-service] launchQuickAgent succeeded: agentId=${launchResult.agentId}`);
        const record = registry.get(launchResult.agentId);
        if (record) {
          // Mark this record as the dedicated supervisor so future
          // setAppRemote(true) calls reuse it instead of spawning duplicates.
          record.appRemoteSupervisor = true;
          notifier.notifyRenderer('agent:status-changed', {
            agentId: launchResult.agentId,
            status: record.status,
            summary: record.summary,
            spaceId: record.spaceId,
          });
        }
        // Enable remote with a timeout — if the RPC hangs, we still return
        // so the renderer can show the agent and wait for the async URL event.
        agents.push({ agentId: launchResult.agentId });
        try {
          const remoteResult = await Promise.race([
            enableRemoteControl(launchResult.agentId),
            new Promise<{ error: string }>(resolve =>
              setTimeout(() => resolve({ error: 'Timed out waiting for remote URL' }), 10_000)
            ),
          ]);
          console.log(`[agent-service] enableRemoteControl result:`, JSON.stringify(remoteResult));
          if ('url' in remoteResult && remoteResult.url) {
            agents[agents.length - 1].url = remoteResult.url;
          } else if ('error' in remoteResult) {
            console.error(`[agent-service] enableRemoteControl error:`, remoteResult.error);
          } else {
            console.warn(`[agent-service] enableRemoteControl returned no URL`);
          }
        } catch (err: any) {
          console.error(`[agent-service] enableRemoteControl threw:`, err);
        }
      }
    }

    // Also enable remote on any other running agents (idempotent for those
    // that already have remote on).
    for (const record of registry.values()) {
      if (record.status !== 'running' && record.status !== 'waiting-approval') continue;
      if (agents.some(a => a.agentId === record.agentId)) continue; // already handled
      try {
        const result = await enableRemoteControl(record.agentId);
        if ('url' in result && result.url) {
          agents.push({ agentId: record.agentId, url: result.url });
        }
      } catch (err: any) {
        console.error(`[agent-service] Failed to enable remote for agent=${record.agentId}:`, err);
      }
    }
  } else {
    for (const record of registry.values()) {
      if (record.status !== 'running' && record.status !== 'waiting-approval') continue;
      try {
        await disableRemoteControl(record.agentId);
      } catch (err: any) {
        console.error(`[agent-service] Failed to disable remote for agent=${record.agentId}:`, err);
      }
    }
    // Clear supervisor flags so a future enable starts cleanly.
    for (const record of registry.values()) {
      if (record.appRemoteSupervisor) record.appRemoteSupervisor = false;
    }
  }

  notifier.notifyRenderer('app:remote-changed', { enabled, agents });
  return { enabled, agents };
}

/**
 * Get the current app-level remote status and list of agents with remote URLs.
 */
export function getAppRemoteStatus(): { enabled: boolean; agents: Array<{ agentId: string; url?: string }> } {
  const { getConfigValue } = require('./config');
  const enabled = !!getConfigValue('remoteEnabled');
  const agents: Array<{ agentId: string; url?: string }> = [];

  if (enabled) {
    for (const record of registry.values()) {
      if (record.remote?.enabled && record.remote.url) {
        agents.push({ agentId: record.agentId, url: record.remote.url });
      }
    }
  }

  return { enabled, agents };
}

/**
 * Test-only helper.  Resets the in-flight guard and clears the agent registry
 * so unit tests can run setAppRemote scenarios in isolation.  Not for production use.
 */
export function __resetAppRemoteForTests(): { registry: AgentRegistry } {
  appRemoteInFlight = null;
  registry.clear();
  return { registry };
}

// ── Re-exports from CLI runner ─────────────────────────
export { launchCliSession, startCliExitMonitor, stopCliExitMonitor, openAgentCli } from './agents/cli-runner';

// ── Re-exports from comment workflow ───────────────────
export { launchCommentAgent } from './agents/comment-workflow';

// ── Interaction passthrough ────────────────────────────

export function approveAgent(agentId: string, requestId: string, approved: boolean): void {
  broker.approveAgent(agentId, requestId, approved);
}

export function respondToUserInput(agentId: string, requestId: string, answer: string, wasFreeform: boolean): void {
  broker.respondToUserInput(agentId, requestId, answer, wasFreeform);
}

export function respondToElicitation(agentId: string, requestId: string, action: 'accept' | 'decline' | 'cancel', content?: Record<string, unknown>): void {
  broker.respondToElicitation(agentId, requestId, action, content);
}

/**
 * Toggle yolo mode for an agent.  When enabled, all subsequent permission
 * requests are auto-approved without user interaction.  Also auto-approves
 * any currently-pending permission requests.
 */
export async function setAgentYolo(agentId: string, enabled: boolean): Promise<{ ok: true } | { error: string }> {
  const record = registry.get(agentId);
  if (!record) return { error: 'Agent not found' };

  record.yoloMode = enabled;
  console.log(`[agent-service] yolo mode ${enabled ? 'enabled' : 'disabled'} for agent=${agentId}`);
  (await persistence.updateYolo(record, enabled));
  notifier.notifyRenderer('agent:yolo-changed', { agentId, enabled });

  // When enabling, auto-approve any pending permission requests
  if (enabled && record.pendingApprovals.size > 0) {
    for (const requestId of [...record.pendingApprovals.keys()]) {
      broker.approveAgent(agentId, requestId, true);
    }
  }

  return { ok: true };
}

/**
 * Renderer-driven resolution of a sandbox block.
 *
 * For `'disable'`: await `disableSandboxForSession` FIRST so the runtime has
 * actually flipped off enforcement, THEN resolve the broker callback. The
 * broker callback resolves the pre-tool hook with `allow`, so resolving it
 * before the disable completes would let the original tool call slip through
 * while the runtime is still sandboxed. The retry prompt fires from inside
 * `disableSandboxForSession` after the runtime update lands.
 *
 * For `'allow-once'` / `'allow-for-session'`: just resolve the broker
 * callback; no runtime change needed.
 */
export async function resolveSandboxBlock(
  agentId: string,
  requestId: string,
  decision: 'allow-once' | 'allow-for-session' | 'disable',
): Promise<void> {
  if (decision === 'disable') {
    const { disableSandboxForSession } = await import('./agents/sdk-runner');
    await disableSandboxForSession(agentId).catch((err) => {
      console.error('[agent-service] disableSandboxForSession failed:', err);
    });
  }
  broker.resolveSandboxBlock(agentId, requestId, decision);
}

// ── Agent lifecycle ────────────────────────────────────

export async function stopWorkspaceAgents(): Promise<void> {
  for (const record of [...registry.values()]) {
    if (record.status === 'running' || record.status === 'waiting-approval') await abortAgent(record.agentId);
  }
}

/** Called only after session shutdown and producer drainage, before changing DBs. */
export function clearWorkspaceAgentState(): void {
  for (const record of registry.values()) {
    broker.clearPendingInteractions(record);
    releaseCanvasInstances(record.agentId);
    endCanvasRun(record.agentId);
    subagentTracker.clearParent(record.agentId);
  }
  registry.clear();
}

export async function abortAgent(agentId: string): Promise<void> {
  const record = registry.get(agentId);
  const persisted = (await persistence.getSession(agentId));
  const source = persisted?.source ?? (record ? 'sdk' : null);
  if (!source) return;
  const status = record?.status ?? persisted?.status;
  const isCloudSdk = source === 'sdk' && (record?.runLocation === 'cloud' || persisted?.run_location === 'cloud');
  if (status === 'completed' || (status === 'failed' && (!isCloudSdk || record?.aborted === true))) return;

  if (source === 'cca') {
    const { stopCloudJobPoller } = await import('./cloud-agent-poller');
    stopCloudJobPoller(agentId);
    const summary = 'Stopped tracking by user. The cloud job may continue running on GitHub.';
    (await persistence.updateSessionStatus(agentId, 'failed', summary));
    notifier.notifyRenderer('agent:status-changed', {
      agentId,
      status: 'failed',
      summary,
      spaceId: persisted?.space_id ?? undefined,
      threadId: persisted?.comment_thread_id ?? undefined,
    });
    return;
  }

  if (source === 'cli') {
    const summary = 'Stopped tracking by user. The terminal session may still be running.';
    (await persistence.updateSessionStatus(agentId, 'failed', summary));
    notifier.notifyRenderer('agent:status-changed', {
      agentId,
      status: 'failed',
      summary,
      spaceId: persisted?.space_id ?? undefined,
    });
    return;
  }

  if (!record) {
    if (!persisted) return;
    const isActive = persisted?.status === 'running' || persisted?.status === 'waiting-approval';
    if (!isActive && !isCloudSdk) return;
    if (persisted.run_location === 'cloud') {
      const { abortRestoredCloudAgent } = await import('./agents/sdk-runner');
      const abortResult = await abortRestoredCloudAgent(agentId);
      if (abortResult === 'retry') {
        const summary = 'Could not reconnect to stop this cloud agent. It may still be running; retry before deleting it.';
        (await persistence.updateSessionStatus(agentId, persisted.status, summary));
        notifier.notifyRenderer('agent:status-changed', {
          agentId,
          status: persisted.status,
          summary,
          spaceId: persisted.space_id ?? undefined,
          threadId: persisted.comment_thread_id ?? undefined,
          trackingError: true,
        });
        throw new Error(summary);
      }
    }
    (await persistence.updateSessionStatus(agentId, 'failed', 'Aborted by user'));
    notifier.notifyRenderer('agent:status-changed', {
      agentId,
      status: 'failed',
      summary: 'Aborted by user',
      spaceId: persisted?.space_id ?? undefined,
      threadId: persisted?.comment_thread_id ?? undefined,
    });
    return;
  }

  if (record.runLocation === 'cloud' && record.phase === 'starting' && !record.session) {
    record.aborted = true;
    const summary = 'Cancellation is waiting for the cloud session to finish starting. Retry deletion after it stops.';
    record.summary = summary;
    (await persistence.updateSessionStatus(agentId, record.status, summary));
    notifier.notifyRenderer('agent:status-changed', {
      agentId,
      status: record.status,
      summary,
      spaceId: record.spaceId,
      threadId: record.commentContext?.threadId,
      trackingError: true,
    });
    throw new Error(summary);
  }

  try {
    if (record.session) await record.session.abort();
  } catch (err) {
    console.warn(`[agent-service] SDK abort failed for ${agentId}:`, err);
    if (record.runLocation === 'cloud') {
      const { isCloudSessionGone } = await import('./agents/sdk-runner');
      if (isCloudSessionGone(err)) {
        console.log(`[agent-service] Cloud session already gone for ${agentId}; clearing local state`);
      } else {
        const summary = 'Could not stop this cloud agent. It may still be running; retry before deleting it.';
        record.summary = summary;
        (await persistence.updateSessionStatus(agentId, record.status, summary));
        notifier.notifyRenderer('agent:status-changed', {
          agentId,
          status: record.status,
          summary,
          spaceId: record.spaceId,
          threadId: record.commentContext?.threadId,
          trackingError: true,
        });
        throw new Error(summary);
      }
    }
  }
  record.aborted = true;
  broker.clearPendingInteractions(record);
  try {
    if (record.session) await record.session.disconnect();
  } catch (err) {
    console.warn(`[agent-service] SDK disconnect failed for ${agentId}:`, err);
  } finally {
    record.aborted = true;
    record.session = undefined;
    record.status = 'failed';
    record.summary = 'Aborted by user';
    (await finishScheduledAgent(record, 'Stopped by user'));
    (await persistence.updateStatus(record));
    notifier.notifyRenderer('agent:status-changed', {
      agentId,
      status: 'failed',
      summary: record.summary,
      spaceId: record.spaceId,
      threadId: record.commentContext?.threadId,
    });
  }
}

export async function deleteAgent(agentId: string): Promise<void> {
  await abortAgent(agentId);
  (await deleteAgentSession(agentId));
  (await forgetAgent(agentId));
}

export async function forgetAgent(agentId: string): Promise<void> {
  const record = registry.get(agentId);
  if (record) {
    record.aborted = true;
    (await finishScheduledAgent(record, 'Agent removed before finishing'));
    broker.clearPendingInteractions(record);
    notifier.notifyRenderer('agent:presence-ended', { agentId, spaceId: record.spaceId });
  }
  // Canvas bookkeeping is keyed by agent id, so it has to be dropped on the
  // common teardown path too. Otherwise a deleted or resumed agent leaves
  // instance bindings and run state behind for the life of the process.
  releaseCanvasInstances(agentId);
  endCanvasRun(agentId);
  registry.delete(agentId);
}

// ── Query functions ────────────────────────────────────

export async function listAgents(spaceId: string): Promise<AgentListSnapshot[]> {
  if (spaceId === '__workspace__') return [];
  const rows = isInitialized() ? (await listAgentSessions(spaceId)).filter(row => row.space_id === spaceId) : [];
  const seen = new Set(rows.map(row => row.id));
  const items = rows.map(row => snapshotAgent(row, false));
  for (const record of registry.values()) {
    if (record.spaceId === spaceId && !seen.has(record.agentId)) items.push(snapshotAgent(ephemeralRow(record), false));
  }
  return items;
}

export function getAgentSessionId(agentId: string): string | null {
  return registry.get(agentId)?.sessionId ?? null;
}

export async function listAllAgents(): Promise<AgentListSnapshot[]> {
  // Read persisted sessions from DB (sorted newest first)
  let persisted: AgentSession[] = [];
  try {
    persisted = (await persistence.listSessions());
  } catch { /* DB may not be initialized */ }

  // Build result: overlay live in-memory state on top of DB records
  const seen = new Set<string>();
  const result: AgentListSnapshot[] = [];

  for (const row of persisted) {
    seen.add(row.id);
    const live = registry.get(row.id);
    const pendingApproval = live?.pendingApprovalId ? live.pendingApprovals.get(live.pendingApprovalId) : undefined;
    result.push({
      agentId: row.id,
      sessionId: row.session_id,
      status: (live?.status ?? row.status) as import('./agents/agent-registry').AgentStatus,
      summary: live?.summary ?? row.summary,
      selectedText: live?.selectedText ?? row.prompt,
      quotedText: live?.commentContext?.quotedText ?? row.quoted_text ?? '',
      anchor: live?.anchor ?? fallbackAnchor(row.quoted_text ?? row.prompt ?? ''),
      spaceId: live?.spaceId ?? row.space_id ?? '__workspace__',
      createdAt: row.created_at,
      pendingApprovalId: live?.pendingApprovalId ?? null,
      pendingPermissionKind: live?.pendingPermissionKind ?? null,
      pendingIntention: pendingApproval?.intention ?? null,
      pendingPath: pendingApproval?.path ?? null,
      source: row.source ?? 'sdk',
      personaHandle: row.persona_handle ?? null,
      yoloMode: live?.yoloMode ?? row.yolo_mode ?? false,
      sandboxed: live?.sandbox?.state === 'on',
      runLocation: row.run_location ?? 'local',
    });
  }

  for (const [id, record] of registry.entries()) {
    if (!seen.has(id)) result.push(snapshotAgent(ephemeralRow(record), false));
  }
  return result;
}

function snapshotAgent(row: AgentSummaryRow, preview: boolean): AgentListSnapshot {
    const live = registry.get(row.id);
    const pending = live?.pendingApprovalId ? live.pendingApprovals.get(live.pendingApprovalId) : undefined;
    const text = (value: string, limit: number) => preview ? value.slice(0, limit) : value;
    return {
      agentId: row.id, sessionId: row.session_id,
      status: live?.status ?? row.status,
      summary: text(live?.summary ?? row.summary, 300),
      selectedText: text(live?.selectedText ?? row.prompt, 160),
      quotedText: text(live?.commentContext?.quotedText ?? row.quoted_text ?? '', 160),
      anchor: preview ? fallbackAnchor('') : live?.anchor ?? fallbackAnchor(row.quoted_text ?? row.prompt),
      spaceId: live?.spaceId ?? row.space_id ?? '__workspace__', createdAt: row.created_at,
      pendingApprovalId: live?.pendingApprovalId ?? null,
      pendingPermissionKind: live?.pendingPermissionKind ?? null,
      pendingIntention: pending?.intention ?? null, pendingPath: pending?.path ?? null,
      source: row.source ?? 'sdk', personaHandle: row.persona_handle ?? null,
      yoloMode: live?.yoloMode ?? !!row.yolo_mode, sandboxed: live?.sandbox?.state === 'on',
      runLocation: row.run_location ?? 'local',
    };
  }

  function ephemeralRow(record: AgentRecord): AgentSummaryRow {
    return {
      id: record.agentId, session_id: record.sessionId, space_id: record.spaceId,
      prompt: record.selectedText, summary: record.summary, status: record.status,
      source: 'sdk', persona_handle: record.personaHandle ?? record.commentContext?.personaHandle ?? null,
      quoted_text: record.commentContext?.quotedText ?? '', run_location: record.runLocation ?? 'local',
      yolo_mode: !!record.yoloMode, created_at: '',
    };
  }

  export async function getAgentDetail(agentId: string): Promise<AgentListSnapshot | null> {
    const live = registry.get(agentId);
    const row = live?.ephemeral ? ephemeralRow(live) : isInitialized() ? await getAgentSession(agentId) : null;
    return row ? snapshotAgent(row, false) : null;
  }

  export async function listAgentsPage(request: AgentPageRequest = {}): Promise<AgentPage> {
    const limit = pageLimit(request);
    if (request.query !== undefined && (typeof request.query !== 'string' || request.query.length > 1024)) throw new Error('Invalid worker query');
    if (request.spaceId !== undefined && typeof request.spaceId !== 'string') throw new Error('Invalid space ID');
    if (request.includePages !== undefined && typeof request.includePages !== 'boolean') throw new Error('Invalid page inclusion flag');
    if (request.cursor !== undefined && (typeof request.cursor !== 'string' || request.cursor.length > 8192)) throw new Error('Invalid page cursor');
    const ephemeral = [...registry.values()].filter(record => record.ephemeral).map(ephemeralRow);
    const query = request.query?.toLowerCase() ?? '';
    const matching = ephemeral.filter(row => (!request.spaceId || row.space_id === request.spaceId
      || (request.includePages && row.space_id?.startsWith(`__page__${request.spaceId}/`)))
      && (!query || row.prompt.toLowerCase().includes(query) || row.summary.toLowerCase().includes(query)))
      .sort((a, b) => a.id.localeCompare(b.id));
    const scope = JSON.stringify(['ephemeral-agents', request.query ?? '', request.spaceId ?? '', !!request.includePages]);
    const ephemeralCursor = request.cursor?.startsWith('ephemeral:');
    const page = isInitialized() ? await listAgentSummaries(ephemeralCursor ? { ...request, cursor: undefined, limit: 1 } : request)
      : { items: [], total: 0, nextCursor: null, counts: { running: 0, waiting: 0, completed: 0, failed: 0 } };
    for (const row of ephemeral) {
      const key = row.status === 'waiting-approval' ? 'waiting' : row.status;
      page.counts[key]++;
    }
    if (ephemeralCursor || (page.items.length === 0 && matching.length)) {
      const keys = ephemeralCursor ? decodeCursor(request.cursor!.slice('ephemeral:'.length), scope, 1) : null;
      const items = matching.filter(row => !keys || row.id.localeCompare(String(keys[0])) > 0).slice(0, limit + 1);
      const more = items.length > limit;
      if (more) items.pop();
      return {
        items: items.map(row => snapshotAgent(row, true)), total: page.total + matching.length, counts: page.counts,
        offset: page.total + (keys ? matching.filter(row => row.id.localeCompare(String(keys[0])) <= 0).length : 0),
        nextCursor: more ? `ephemeral:${encodeCursor(scope, [items[items.length - 1].id])}` : null,
      };
    }
    return {
      ...page, items: page.items.map(row => snapshotAgent(row, true)), total: page.total + matching.length,
      nextCursor: page.nextCursor ?? (matching.length ? `ephemeral:${encodeCursor(scope, [''])}` : null),
    };
  }

  const historyAttachments = new Map<string, ReturnType<typeof resumeAgentSession>>();
  async function attachHistorySession(agentId: string) {
    let flight = historyAttachments.get(agentId);
    if (!flight) {
      flight = resumeAgentSession(agentId, { allowRestart: false });
      historyAttachments.set(agentId, flight);
    }
    try {
      return await flight;
    } finally {
      if (historyAttachments.get(agentId) === flight) historyAttachments.delete(agentId);
    }
  }

  function savedHistoryCursor(agentId: string, cursor: string | null): string | null {
    if (!cursor) return null;
    const keys = decodeCursor(cursor, `chat:${agentId}`, 1);
    if (!keys) throw new Error('Invalid history cursor');
    return encodeCursor(`save:${agentId}`, keys);
  }

  function savedHistoryWithNotice(agentId: string, page: ChatHistoryPage, failure?: unknown, replaced = false): ChatHistoryPage {
    const detail = failure instanceof Error ? ` ${failure.message.slice(0, 240)}` : '';
    const notice: import('../shared/chat-types').ChatMessage = {
      id: `history-recovery:${agentId}`,
      type: 'session_event',
      eventType: 'info',
      message: replaced
        ? 'Showing saved history, which may be incomplete. The earlier runtime was replaced; messages absent from the saved transcript cannot be recovered from the replacement session.'
        : `Showing saved history, which may be incomplete.${detail} Reopen this conversation to retry recovering older runtime history. No replacement session was created.`,
      timestamp: page.items[page.items.length - 1]?.timestamp ?? new Date().toISOString(),
    };
    const result: ChatHistoryPage = {
      ...page,
      total: page.total + 1,
      items: [...page.items, notice],
      nextCursor: savedHistoryCursor(agentId, page.nextCursor),
    };
    // An almost-full message still needs to remain accessible. In that case
    // page the saved rows after the notice, without mixing runtime ordinals.
    return Buffer.byteLength(JSON.stringify(result)) <= 4 * 1024 * 1024 ? result : {
      ...result, items: [notice], nextCursor: encodeCursor(`save:${agentId}`, [page.watermark + 1]),
    };
  }

  export async function getAgentHistoryPage(agentId: string, request: PageRequest = {}) {
    pageLimit(request);
    if (typeof agentId !== 'string' || !agentId) throw new Error('Invalid agent ID');
    if (request.cursor !== undefined && typeof request.cursor !== 'string') throw new Error('Invalid history cursor');
    if (!isInitialized()) throw new Error('No workspace is open');
    let record = registry.get(agentId);
    if (record?.ephemeral) {
      if (!record.session) throw new Error('Agent is still starting; retry history when it is active');
      return loadRuntimeHistoryPage(agentId, record.session, true, request);
    }
    const persisted = await getAgentSession(agentId);
    const retainedRuntime = persisted?.source === 'sdk' || persisted?.source === 'cli';
    const runtimeId = record?.session?.sessionId ?? persisted?.session_id;
    if (request.cursor) {
      let savedKeys: ReturnType<typeof decodeCursor> = null;
      try {
        savedKeys = decodeCursor(request.cursor, `save:${agentId}`, 1);
      } catch { /* Validate the other two history cursor domains below. */ }
      if (savedKeys) {
        const page = await listAgentHistoryPage(agentId, {
          ...request, cursor: encodeCursor(`chat:${agentId}`, savedKeys),
        });
        return { ...page, total: page.total + 1, nextCursor: savedHistoryCursor(agentId, page.nextCursor) };
      }
      let mirrorCursor = false;
      try {
        decodeCursor(request.cursor, `chat:${agentId}`, 1);
        mirrorCursor = true;
      } catch (error) {
        if (!runtimeId) throw error;
        const keys = decodeCursor(request.cursor, `runtime:${agentId}:${runtimeId}`, 1);
        if (!keys || !Number.isSafeInteger(keys[0]) || Number(keys[0]) < 1)
          throw new Error('Invalid history cursor');
      }
      // Never switch sequence domains midway through paging a saved fallback.
      if (mirrorCursor) {
        return listAgentHistoryPage(agentId, request);
      }
    }
    const page = await listAgentHistoryPage(agentId, request.cursor ? { limit: 1 } : request);
    const needsRuntime = !!record?.runtimeHistory || !!request.cursor || (persisted && (
      page.watermark === 0 || page.runtimeSessionId === persisted.session_id
      || (retainedRuntime && !record && !page.runtimeSessionId)
    ));
    const needsLiveAttachment = !record && persisted?.source === 'sdk'
      && persisted.run_location === 'cloud' && ACTIVE_WORKER_STATUSES.has(persisted.status);
    if (!needsRuntime && !needsLiveAttachment) {
      return page.runtimeSessionId ? savedHistoryWithNotice(agentId, page, undefined, true) : page;
    }
    try {
      if (!record) {
        if (!await attachHistorySession(agentId)) throw new Error('The runtime session is unavailable; no complete mirrored history exists');
        record = registry.get(agentId);
      }
      if (!record?.session) throw new Error('Agent history is not available yet; retry when the session is active');
      if (!needsRuntime) return savedHistoryWithNotice(agentId, page, undefined, true);
      if (!record.runtimeHistory && persisted) await persistence.prepareHistoryMirror(agentId, persisted.session_id);
      record.runtimeHistory = true;
      const runtimePage = await loadRuntimeHistoryPage(agentId, record.session, false, request);
      if (runtimePage.total === 0 && page.total > 0) throw new Error('The runtime returned no retained conversation history.');
      return runtimePage;
    } catch (error) {
      if (request.cursor || page.total === 0) throw error;
      console.warn(`[agent-service] Retained history recovery failed for ${agentId}; keeping the saved transcript:`, error);
      return savedHistoryWithNotice(agentId, page, error);
    }
  }

/** Minimal worker shape consumed by the system tray menu. */
export interface TrayWorker {
  agentId: string;
  status: import('./agents/agent-registry').AgentStatus;
  summary: string;
  selectedText: string;
  source: 'sdk' | 'cli' | 'cca';
  spaceId: string;
}

const ACTIVE_WORKER_STATUSES = new Set<string>(['running', 'waiting-approval']);

/**
 * Active workers for the tray menu: only `running` / `waiting-approval`, and
 * excluding internal workspace-level supervisors (`spaceId === '__workspace__'`)
 * so the menu shows user-meaningful workers only.
 */
export async function listTrayWorkers(): Promise<TrayWorker[]> {
  const rows = isInitialized() ? (await listAgentSummaries({ limit: 50, activeOnly: true })).items : [];
  const items = new Map(rows.map(row => [row.id, snapshotAgent(row, true)]));
  for (const record of registry.values()) {
    if (ACTIVE_WORKER_STATUSES.has(record.status)) items.set(record.agentId, snapshotAgent(ephemeralRow(record), true));
  }
  return [...items.values()]
    .filter((a) => ACTIVE_WORKER_STATUSES.has(a.status) && a.spaceId !== '__workspace__')
    .slice(0, 50)
    .map((a) => ({
      agentId: a.agentId,
      status: a.status,
      summary: a.summary,
      selectedText: a.selectedText,
      source: a.source,
      spaceId: a.spaceId,
    }));
}

/**
 * Subscribe to changes that affect the active-worker list (status transitions
 * and completions). Reuses the main-process event mirror in `web/event-hub`,
 * which already carries `agent:status-changed` and `agent:completed`. Returns
 * an unsubscribe function.
 */
export function onAgentListChanged(listener: () => void): () => void {
  return subscribeWebRemoteEvents((event) => {
    if (event.channel === 'agent:status-changed' || event.channel === 'agent:completed') {
      listener();
    }
  });
}

/**
 * Mark any DB agent sessions still in "running" or "waiting-approval" state
 * as "failed" when no corresponding live process exists.  This handles the
 * case where the app quit while agents were active — the in-memory registry
 * is lost on restart so these entries would otherwise stay stale forever.
 *
 * Cloud sessions and external CLI sessions are explicitly preserved. Their
 * workers can outlive this app process, and CLI launch does not expose a
 * reliable child PID for liveness checks. The CLI exit-signal monitor remains
 * responsible for converting preserved CLI sessions to completed.
 *
 * Call once after DB + agent-service initialization.
 */
export async function reconcileStaleAgents(): Promise<void> {
  const STALE_STATUSES = new Set(['running', 'waiting-approval']);

  // ── agent_sessions table ──────────────────────────────
  let persisted: AgentSession[] = [];
  try {
    persisted = (await persistence.listSessions());
  } catch { return; /* DB not ready */ }

  for (const row of persisted) {
    if (STALE_STATUSES.has(row.status) && !registry.has(row.id)) {
      // The terminal process is external and may still be alive. Since the
      // launcher does not provide a process identity we can verify, preserve
      // the active state until its durable exit signal arrives.
      if (row.source === 'cli') {
        console.log(`[agent-service] Preserving external CLI session ${row.id} across restart (status=${row.status})`);
        continue;
      }
      // Cloud sessions persist across app restarts — the runtime is remote
      // and the user can resume by clicking the session.  Don't mark these
      // as failed.
      if (row.run_location === 'cloud') {
        console.log(`[agent-service] Preserving cloud agent session ${row.id} across restart (status=${row.status})`);
        continue;
      }
      try {
        (await persistence.updateSessionStatus(row.id, 'failed', RESTART_INTERRUPTION_SUMMARY));
        console.log(`[agent-service] Reconciled stale agent session ${row.id}: ${row.status} → failed`);
      } catch { /* non-fatal */ }
    }
  }

  // ── canvas_agents table ───────────────────────────────
  let runningCanvas: CanvasAgent[] = [];
  try {
    runningCanvas = (await listAllRunningAgents());
  } catch { return; }

  for (const row of runningCanvas) {
    if (!registry.has(row.id)) {
      try {
        (await updateCanvasAgentStatus(row.id, 'failed'));
        console.log(`[agent-service] Reconciled stale canvas agent ${row.id}: running → failed`);
      } catch { /* non-fatal */ }
    }
  }
}

/** Coarse thread status for a *live* comment agent, mirroring the renderer's
 *  threadStatusForAgent so rehydrated and live state agree. */
function liveThreadStatus(record: AgentRecord): CanvasAgentStateSnapshot['status'] {
  if (record.status === 'failed') return 'failed';
  if (record.status === 'completed') return 'completed';
  if (record.status === 'waiting-approval' || broker.snapshotPendingInteractions(record.agentId).length > 0) {
    return 'waiting';
  }
  return record.phase === 'active' ? 'active' : 'starting';
}

/**
 * Snapshot the live + persisted state of every comment-thread agent bound to a
 * space, so a freshly mounted canvas — after in-app navigation, opening a
 * pop-out window, or an app restart — can rehydrate presence cursors, thread
 * status, and pending interactions instead of showing a dead canvas.
 *
 * One representative agent is returned per thread (the most recently created),
 * so a thread that was retried surfaces its latest attempt.  Status mapping:
 *   - a live agent still working            → active / waiting / starting
 *   - a cloud agent that survived a restart → active (it keeps running remotely
 *                                             and is resumable on click)
 *   - a local agent whose process is gone   → failed ("needs redeploy")
 *   - a completed agent                     → omitted (its reply is already
 *                                             persisted in the thread)
 *
 * Pending interactions are only present for agents still live in this process
 * (the broker holds them in memory); after a restart the array is empty.
 */
export async function getCanvasAgentState(spaceId: string): Promise<CanvasAgentStateSnapshot[]> {
  let persisted: AgentSession[] = [];
  try {
    persisted = (await persistence.listSessions());
  } catch {
    return [];
  }

  // listSessions() is newest-first — keep the first (newest) row per thread.
  const byThread = new Map<string, AgentSession>();
  for (const row of persisted) {
    if (row.space_id !== spaceId) continue;
    if (!row.comment_thread_id) continue;
    if (!byThread.has(row.comment_thread_id)) byThread.set(row.comment_thread_id, row);
  }

  const out: CanvasAgentStateSnapshot[] = [];
  for (const [threadId, row] of byThread) {
    const live = registry.get(row.id);
    let status: CanvasAgentStateSnapshot['status'];
    let presenceAnchor: { prefix?: string; suffix?: string } | undefined;

    if (live) {
      status = liveThreadStatus(live);
      presenceAnchor = live.commentContext?.anchor;
    } else if (row.run_location === 'cloud' && (row.status === 'running' || row.status === 'waiting-approval')) {
      status = 'active';
    } else if (row.status === 'completed') {
      continue; // reply already in the thread; no live badge needed
    } else {
      status = 'failed'; // local agent lost to a restart, or a genuine failure
    }
    if (status === 'completed') continue;

    out.push({
      agentId: row.id,
      threadId,
      personaHandle: (live?.commentContext?.personaHandle ?? row.persona_handle) ?? '',
      status,
      ...(presenceAnchor ? { presenceAnchor } : {}),
      pendingInteractions: broker.snapshotPendingInteractions(row.id),
    });
  }
  return out;
}
