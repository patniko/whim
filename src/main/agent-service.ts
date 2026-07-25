import { AgentAnchor, AgentSession, CanvasAgent, CanvasAgentStateSnapshot } from '../shared/types';
import { SubagentTracker } from './subagent-service';
import { AgentRegistry } from './agents/agent-registry';
import type { AgentRecord } from './agents/agent-registry';
import { AgentNotifier } from './agents/agent-notifier';
import { AgentPersistence } from './agents/agent-persistence';
import { InteractionBroker } from './agents/interaction-broker';
import { deleteAgentSession, listAllRunningAgents, updateCanvasAgentStatus } from './database';
import { subscribeWebRemoteEvents } from './web/event-hub';

// Import runner modules
import { initSdkRunner, setupAgentEventListeners } from './agents/sdk-runner';
import { initCliRunner } from './agents/cli-runner';
import { initCommentWorkflow } from './agents/comment-workflow';

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
export function setAppRemote(enabled: boolean): Promise<AppRemoteResult> {
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
export function setAgentYolo(agentId: string, enabled: boolean): { ok: true } | { error: string } {
  const record = registry.get(agentId);
  if (!record) return { error: 'Agent not found' };

  record.yoloMode = enabled;
  console.log(`[agent-service] yolo mode ${enabled ? 'enabled' : 'disabled'} for agent=${agentId}`);
  persistence.updateYolo(record, enabled);
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

export async function abortAgent(agentId: string): Promise<void> {
  const record = registry.get(agentId);
  const persisted = persistence.getSession(agentId);
  const source = persisted?.source ?? (record ? 'sdk' : null);
  if (!source) return;
  const status = record?.status ?? persisted?.status;
  const isCloudSdk = source === 'sdk' && (record?.runLocation === 'cloud' || persisted?.run_location === 'cloud');
  if (status === 'completed' || (status === 'failed' && (!isCloudSdk || record?.aborted === true))) return;

  if (source === 'cca') {
    const { stopCloudJobPoller } = await import('./cloud-agent-poller');
    stopCloudJobPoller(agentId);
    const summary = 'Stopped tracking by user. The cloud job may continue running on GitHub.';
    persistence.updateSessionStatus(agentId, 'failed', summary);
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
    persistence.updateSessionStatus(agentId, 'failed', summary);
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
        persistence.updateSessionStatus(agentId, persisted.status, summary);
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
    persistence.updateSessionStatus(agentId, 'failed', 'Aborted by user');
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
    persistence.updateSessionStatus(agentId, record.status, summary);
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
        persistence.updateSessionStatus(agentId, record.status, summary);
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
    persistence.updateStatus(record);
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
  deleteAgentSession(agentId);
  forgetAgent(agentId);
}

export function forgetAgent(agentId: string): void {
  const record = registry.get(agentId);
  if (record) {
    record.aborted = true;
    broker.clearPendingInteractions(record);
    notifier.notifyRenderer('agent:presence-ended', { agentId, spaceId: record.spaceId });
  }
  registry.delete(agentId);
}

// ── Query functions ────────────────────────────────────

export function listAgents(spaceId: string): AgentListSnapshot[] {
  return listAllAgents().filter(a => a.spaceId === spaceId && a.spaceId !== '__workspace__');
}

export function getAgentSessionId(agentId: string): string | null {
  return registry.get(agentId)?.sessionId ?? null;
}

export function listAllAgents(): AgentListSnapshot[] {
  // Read persisted sessions from DB (sorted newest first)
  let persisted: AgentSession[] = [];
  try {
    persisted = persistence.listSessions();
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

  // Add any live agents not yet in DB (shouldn't happen, but defensive)
  for (const [id, a] of registry.entries()) {
    if (!seen.has(id)) {
      const pendingApproval = a.pendingApprovalId ? a.pendingApprovals.get(a.pendingApprovalId) : undefined;
      result.push({
        agentId: a.agentId,
        sessionId: a.sessionId,
        status: a.status,
        summary: a.summary,
        selectedText: a.selectedText,
        quotedText: a.commentContext?.quotedText ?? '',
        anchor: a.anchor,
        spaceId: a.spaceId,
        createdAt: '',
        pendingApprovalId: a.pendingApprovalId,
        pendingPermissionKind: a.pendingPermissionKind ?? null,
        pendingIntention: pendingApproval?.intention ?? null,
        pendingPath: pendingApproval?.path ?? null,
        source: 'sdk',
        personaHandle: a.commentContext?.personaHandle ?? null,
        yoloMode: a.yoloMode ?? false,
        sandboxed: a.sandbox?.state === 'on',
        runLocation: a.runLocation ?? 'local',
      });
    }
  }

  return result;
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
export function listTrayWorkers(): TrayWorker[] {
  return listAllAgents()
    .filter((a) => ACTIVE_WORKER_STATUSES.has(a.status) && a.spaceId !== '__workspace__')
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
export function reconcileStaleAgents(): void {
  const STALE_STATUSES = new Set(['running', 'waiting-approval']);

  // ── agent_sessions table ──────────────────────────────
  let persisted: AgentSession[] = [];
  try {
    persisted = persistence.listSessions();
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
        persistence.updateSessionStatus(row.id, 'failed', 'Session lost — app restarted');
        console.log(`[agent-service] Reconciled stale agent session ${row.id}: ${row.status} → failed`);
      } catch { /* non-fatal */ }
    }
  }

  // ── canvas_agents table ───────────────────────────────
  let runningCanvas: CanvasAgent[] = [];
  try {
    runningCanvas = listAllRunningAgents();
  } catch { return; }

  for (const row of runningCanvas) {
    if (!registry.has(row.id)) {
      try {
        updateCanvasAgentStatus(row.id, 'failed');
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
export function getCanvasAgentState(spaceId: string): CanvasAgentStateSnapshot[] {
  let persisted: AgentSession[] = [];
  try {
    persisted = persistence.listSessions();
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
