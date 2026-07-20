import { BrowserWindow } from 'electron';
import { v4 as uuid } from 'uuid';
import {
  getCloudJobStatus,
  getGitHubToken,
  getWorkspaceRepo,
  launchCloudAgentWithFallback,
  type CloudJobFallbackInfo,
  type CloudJobStatus,
} from './cloud-agent';
import {
  createAgentSession,
  isInitialized,
  listAgentSessions,
  updateAgentSessionCcaResult,
  updateAgentSessionStatus,
} from './database';
import { mirrorRendererEvent } from './web/event-hub';

const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_BACKOFF_MS = 5 * 60_000;
const RESTORE_RETRY_MS = 30_000;

interface PollState {
  agentId: string;
  owner: string;
  repo: string;
  jobId: string;
  token: string;
  timer: ReturnType<typeof setTimeout> | null;
  lastStatus: CloudJobStatus | null;
  consecutiveErrors: number;
  stopped: boolean;
  url: string;
}

export interface LaunchTrackedCloudAgentOptions {
  spaceId: string | null;
  prompt: string;
  workspace: string;
  personaHandle?: string | null;
  displayPrompt?: string;
  quotedText?: string;
  threadId?: string | null;
}

const activePollers = new Map<string, PollState>();
let restoreRetryTimer: ReturnType<typeof setTimeout> | null = null;

function notifyAllWindows(channel: string, ...args: any[]): void {
  mirrorRendererEvent(channel, ...args);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}

function parseRepository(repository: string | null | undefined): { owner: string; repo: string } | null {
  if (!repository) return null;
  const slash = repository.indexOf('/');
  if (slash <= 0 || slash === repository.length - 1) return null;
  return { owner: repository.slice(0, slash), repo: repository.slice(slash + 1) };
}

function isTerminalStatus(status: string): boolean {
  return ['completed', 'succeeded', 'failed', 'error', 'cancelled'].includes(status);
}

function isCloudJobError(result: CloudJobStatus | { error: string }): result is { error: string } {
  return typeof result.error === 'string';
}

function mapAgentStatus(status: CloudJobStatus): { status: 'running' | 'completed' | 'failed'; summary: string } {
  const cloudStatus = status.status;
  let summary = status.result || status.problemStatement || '';

  if (cloudStatus === 'completed' || cloudStatus === 'succeeded') {
    if (status.pullRequest?.url) summary = `PR: ${status.pullRequest.url}`;
    return { status: 'completed', summary };
  }
  if (cloudStatus === 'failed' || cloudStatus === 'error' || cloudStatus === 'cancelled') {
    return { status: 'failed', summary: status.error?.message || `Job ${cloudStatus}` };
  }
  return { status: 'running', summary };
}

function scheduleNextPoll(state: PollState, delayMs = POLL_INTERVAL_MS): void {
  if (state.stopped || activePollers.get(state.agentId) !== state) return;
  state.timer = setTimeout(() => {
    void pollCloudJob(state);
  }, delayMs);
  state.timer.unref?.();
}

function reportTrackingError(state: PollState, message: string): void {
  const retrySeconds = Math.round(
    Math.min(POLL_INTERVAL_MS * 2 ** Math.max(0, state.consecutiveErrors - 1), MAX_POLL_BACKOFF_MS) / 1000,
  );
  notifyAllWindows('agent:status-changed', {
    agentId: state.agentId,
    status: 'running',
    summary: `Cloud tracking temporarily unavailable: ${message}. Retrying in ${retrySeconds}s.`,
    trackingError: true,
  });
}

async function handlePollFailure(state: PollState, message: string, error?: unknown): Promise<void> {
  state.consecutiveErrors += 1;
  console.error(`[cloud-poller] Polling failure for ${state.jobId} (attempt ${state.consecutiveErrors}):`, error ?? message);

  // Refresh credentials periodically so a `gh auth login` or token rotation
  // can heal a live poller without requiring an app restart.
  if (state.consecutiveErrors % 3 === 0) {
    try {
      const refreshedToken = await getGitHubToken();
      if (refreshedToken) state.token = refreshedToken;
    } catch (refreshError) {
      console.warn(`[cloud-poller] Token refresh failed for ${state.jobId}:`, refreshError);
    }
  }
  if (state.stopped || activePollers.get(state.agentId) !== state) return;

  reportTrackingError(state, message);
  const delay = Math.min(POLL_INTERVAL_MS * 2 ** Math.max(0, state.consecutiveErrors - 1), MAX_POLL_BACKOFF_MS);
  scheduleNextPoll(state, delay);
}

async function pollCloudJob(state: PollState): Promise<void> {
  if (state.stopped || activePollers.get(state.agentId) !== state) return;

  try {
    const result = await getCloudJobStatus(state.owner, state.repo, state.jobId, state.token);
    if (state.stopped || activePollers.get(state.agentId) !== state) return;

    if (isCloudJobError(result)) {
      await handlePollFailure(state, result.error);
      return;
    }

    state.consecutiveErrors = 0;
    state.lastStatus = result;
    if (result.pullRequest?.url) state.url = result.pullRequest.url;

    updateAgentSessionCcaResult(state.agentId, JSON.stringify({ ...result, url: state.url }));
    const mapped = mapAgentStatus(result);
    updateAgentSessionStatus(state.agentId, mapped.status, mapped.summary);
    notifyAllWindows('agent:status-changed', {
      agentId: state.agentId,
      status: mapped.status,
      summary: mapped.summary,
    });

    if (isTerminalStatus(result.status)) {
      stopCloudJobPoller(state.agentId);
      notifyAllWindows('agent:completed', { agentId: state.agentId, status: mapped.status });
      return;
    }
    scheduleNextPoll(state);
  } catch (error) {
    if (state.stopped || activePollers.get(state.agentId) !== state) return;
    const message = error instanceof Error ? error.message : String(error);
    await handlePollFailure(state, message, error);
  }
}

export function startCloudJobPoller(
  agentId: string,
  owner: string,
  repo: string,
  jobId: string,
  token: string,
): void {
  if (activePollers.has(agentId)) return;

  const state: PollState = {
    agentId,
    owner,
    repo,
    jobId,
    token,
    timer: null,
    lastStatus: null,
    consecutiveErrors: 0,
    stopped: false,
    url: `https://github.com/${owner}/${repo}`,
  };
  activePollers.set(agentId, state);
  void pollCloudJob(state);
}

export function stopCloudJobPoller(agentId: string): boolean {
  const state = activePollers.get(agentId);
  if (!state) return false;
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  activePollers.delete(agentId);
  return true;
}

export function getCloudJobPollResult(agentId: string): (CloudJobStatus & { url?: string }) | null {
  const state = activePollers.get(agentId);
  if (!state) return null;
  return state.lastStatus ? { ...state.lastStatus, url: state.url } : null;
}

export function stopAllCloudPollers(): void {
  if (restoreRetryTimer) {
    clearTimeout(restoreRetryTimer);
    restoreRetryTimer = null;
  }
  for (const id of [...activePollers.keys()]) stopCloudJobPoller(id);
}

export async function launchTrackedCloudAgent(
  options: LaunchTrackedCloudAgentOptions,
): Promise<
  | { agentId: string; sessionId: string; jobId: string; fallback?: CloudJobFallbackInfo }
  | { error: string; [key: string]: unknown }
> {
  const repoInfo = await getWorkspaceRepo(options.workspace);
  if (!repoInfo) return { error: 'Could not determine repository from workspace. Ensure a git remote is configured.' };

  const token = await getGitHubToken();
  if (!token) return { error: 'No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN.' };

  const launch = await launchCloudAgentWithFallback(repoInfo.owner, repoInfo.repo, options.prompt, token);
  if ('error' in launch) return launch;
  const { result, fallback } = launch;
  const effective = fallback
    ? { owner: fallback.effectiveOwner, repo: fallback.effectiveRepo }
    : repoInfo;
  const agentId = uuid();
  const now = new Date().toISOString();
  const summary = fallback
    ? `Cloud job ${result.jobId} on fork ${effective.owner}/${effective.repo} (upstream ${repoInfo.owner}/${repoInfo.repo} blocked by SSO)`
    : `Cloud job ${result.jobId}`;

  createAgentSession({
    id: agentId,
    session_id: result.sessionId,
    space_id: options.spaceId,
    prompt: options.displayPrompt ?? options.prompt,
    status: 'running',
    summary,
    working_dir: options.workspace,
    source: 'cca',
    persona_handle: options.personaHandle ?? null,
    quoted_text: options.quotedText ?? null,
    comment_thread_id: options.threadId ?? null,
    run_location: 'cloud',
    cca_job_id: result.jobId,
    cca_repository: `${repoInfo.owner}/${repoInfo.repo}`,
    cca_effective_repository: `${effective.owner}/${effective.repo}`,
    cca_fallback_json: fallback ? JSON.stringify(fallback) : null,
    cca_result_json: JSON.stringify(result),
    created_at: now,
    updated_at: now,
  });

  startCloudJobPoller(agentId, effective.owner, effective.repo, result.jobId, token);
  notifyAllWindows('agent:status-changed', {
    agentId,
    status: 'running',
    summary,
    fallback,
    spaceId: options.spaceId,
    threadId: options.threadId ?? null,
  });
  return { agentId, sessionId: result.sessionId, jobId: result.jobId, fallback };
}

export async function restoreActiveCloudPollers(): Promise<void> {
  if (restoreRetryTimer) {
    clearTimeout(restoreRetryTimer);
    restoreRetryTimer = null;
  }
  if (!isInitialized()) return;
  const active = listAgentSessions().filter(
    (session) => session.source === 'cca' && (session.status === 'running' || session.status === 'waiting-approval'),
  );
  if (active.length === 0) return;

  let token: string | null = null;
  try {
    token = await getGitHubToken();
  } catch (error) {
    console.warn('[cloud-poller] GitHub token lookup failed during recovery:', error);
  }
  for (const session of active) {
    if (activePollers.has(session.id)) continue;
    const repository = parseRepository(session.cca_effective_repository ?? session.cca_repository);
    if (!session.cca_job_id || !repository) {
      updateAgentSessionStatus(
        session.id,
        'failed',
        'Cloud session cannot be recovered because its job metadata is missing. Relaunch the task.',
      );
      continue;
    }
    if (!token) {
      notifyAllWindows('agent:status-changed', {
        agentId: session.id,
        status: session.status,
        summary: 'Cloud tracking paused. Sign in with `gh auth login`; recovery will retry automatically.',
        trackingError: true,
      });
      continue;
    }
    startCloudJobPoller(session.id, repository.owner, repository.repo, session.cca_job_id, token);
  }

  if (!token && active.some((session) => session.cca_job_id && parseRepository(session.cca_effective_repository ?? session.cca_repository))) {
    restoreRetryTimer = setTimeout(() => {
      restoreRetryTimer = null;
      void restoreActiveCloudPollers().catch((error) => {
        console.warn('[cloud-poller] Deferred recovery failed:', error);
      });
    }, RESTORE_RETRY_MS);
    restoreRetryTimer.unref?.();
  }
}
