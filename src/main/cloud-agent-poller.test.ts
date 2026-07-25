import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'agent-1'),
}));

vi.mock('./cloud-agent', () => ({
  getCloudJobStatus: vi.fn(),
  getGitHubToken: vi.fn(),
  getWorkspaceRepo: vi.fn(),
  launchCloudAgentWithFallback: vi.fn(),
}));

vi.mock('./database', () => ({
  createAgentSession: vi.fn(),
  isInitialized: vi.fn(() => true),
  listAgentSessions: vi.fn(() => []),
  updateAgentSessionCcaResult: vi.fn(),
  updateAgentSessionStatus: vi.fn(),
}));

vi.mock('./web/event-hub', () => ({
  mirrorRendererEvent: vi.fn(),
}));

import {
  getCloudJobStatus,
  getGitHubToken,
  getWorkspaceRepo,
  launchCloudAgentWithFallback,
} from './cloud-agent';
import {
  createAgentSession,
  listAgentSessions,
  updateAgentSessionCcaResult,
  updateAgentSessionStatus,
} from './database';
import {
  getCloudJobPollResult,
  launchTrackedCloudAgent,
  restoreActiveCloudPollers,
  startCloudJobPoller,
  stopAllCloudPollers,
  stopCloudJobPoller,
} from './cloud-agent-poller';
import { mirrorRendererEvent } from './web/event-hub';

const runningStatus = {
  jobId: 'job-1',
  sessionId: 'session-1',
  problemStatement: 'do work',
  status: 'running',
  actor: { id: 'user-1', login: 'octocat' },
  createdAt: '2026-07-20T00:00:00Z',
  updatedAt: '2026-07-20T00:00:01Z',
};

describe('cloud-agent-poller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    stopAllCloudPollers();
    vi.mocked(getCloudJobStatus).mockResolvedValue(runningStatus);
    vi.mocked(getGitHubToken).mockResolvedValue('token');
  });

  it('polls immediately, persists results, and starts idempotently', async () => {
    startCloudJobPoller('agent-1', 'owner', 'repo', 'job-1', 'token');
    startCloudJobPoller('agent-1', 'owner', 'repo', 'job-1', 'token');
    await vi.advanceTimersByTimeAsync(0);

    expect(getCloudJobStatus).toHaveBeenCalledTimes(1);
    expect(updateAgentSessionCcaResult).toHaveBeenCalledWith(
      'agent-1',
      expect.stringContaining('"status":"running"'),
    );
    expect(getCloudJobPollResult('agent-1')).toMatchObject({ status: 'running' });
  });

  it('ignores an in-flight result after polling is stopped', async () => {
    let resolveStatus!: (value: typeof runningStatus) => void;
    vi.mocked(getCloudJobStatus).mockReturnValue(new Promise((resolve) => {
      resolveStatus = resolve;
    }));

    startCloudJobPoller('agent-1', 'owner', 'repo', 'job-1', 'token');
    expect(stopCloudJobPoller('agent-1')).toBe(true);
    resolveStatus(runningStatus);
    await Promise.resolve();

    expect(updateAgentSessionStatus).not.toHaveBeenCalled();
    expect(updateAgentSessionCcaResult).not.toHaveBeenCalled();
  });

  it('keeps live jobs recoverable and backs off after consecutive polling errors', async () => {
    vi.mocked(getCloudJobStatus).mockResolvedValue({ error: 'unauthorized' });
    startCloudJobPoller('agent-1', 'owner', 'repo', 'job-1', 'token');

    await vi.advanceTimersByTimeAsync(70_000);

    expect(getCloudJobStatus).toHaveBeenCalledTimes(4);
    expect(updateAgentSessionStatus).not.toHaveBeenCalled();
    expect(mirrorRendererEvent).toHaveBeenCalledWith(
      'agent:status-changed',
      expect.objectContaining({
        agentId: 'agent-1',
        status: 'running',
        trackingError: true,
      }),
    );
    expect(stopCloudJobPoller('agent-1')).toBe(true);
  });

  it('leaves active sessions persisted when auth is missing and retries recovery', async () => {
    vi.mocked(listAgentSessions).mockReturnValue([{
      id: 'recoverable', session_id: 'session-1', space_id: null, prompt: 'p',
      status: 'running', summary: 'Cloud job job-1', working_dir: '/ws', source: 'cca',
      persona_handle: null, quoted_text: null, run_location: 'cloud',
      cca_job_id: 'job-1', cca_repository: 'owner/repo',
      cca_effective_repository: 'owner/repo',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    }]);
    vi.mocked(getGitHubToken)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('new-token');

    await restoreActiveCloudPollers();
    expect(updateAgentSessionStatus).not.toHaveBeenCalled();
    expect(mirrorRendererEvent).toHaveBeenCalledWith(
      'agent:status-changed',
      expect.objectContaining({ status: 'running', trackingError: true }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(getCloudJobStatus).toHaveBeenCalledWith('owner', 'repo', 'job-1', 'new-token');
  });

  it('restores recoverable CCA sessions without falsely failing legacy rows', async () => {
    vi.mocked(listAgentSessions).mockReturnValue([
      {
        id: 'recoverable', session_id: 'session-1', space_id: null, prompt: 'p',
        status: 'running', summary: '', working_dir: '/ws', source: 'cca',
        persona_handle: null, quoted_text: null, run_location: 'cloud',
        cca_job_id: 'job-1', cca_repository: 'upstream/repo',
        cca_effective_repository: 'fork/repo',
        created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
      },
      {
        id: 'legacy', session_id: 'session-2', space_id: null, prompt: 'p',
        status: 'running', summary: '', working_dir: '/ws', source: 'cca',
        persona_handle: null, quoted_text: null, run_location: 'cloud',
        created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
      },
    ]);

    await restoreActiveCloudPollers();
    await vi.advanceTimersByTimeAsync(0);

    expect(getCloudJobStatus).toHaveBeenCalledWith('fork', 'repo', 'job-1', 'token');
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'legacy',
      'running',
      expect.stringContaining('remote task may still be running'),
    );
    expect(mirrorRendererEvent).toHaveBeenCalledWith(
      'agent:status-changed',
      expect.objectContaining({
        agentId: 'legacy',
        status: 'running',
        trackingError: true,
      }),
    );
  });

  it('launches and persists complete CCA recovery metadata', async () => {
    vi.mocked(getWorkspaceRepo).mockResolvedValue({ owner: 'upstream', repo: 'repo' });
    vi.mocked(launchCloudAgentWithFallback).mockResolvedValue({
      result: {
        jobId: 'job-1',
        sessionId: 'session-1',
        actor: { id: 'user-1', login: 'octocat' },
        createdAt: '2026-07-20T00:00:00Z',
        updatedAt: '2026-07-20T00:00:00Z',
      },
      fallback: {
        effectiveOwner: 'fork',
        effectiveRepo: 'repo',
        upstream: { owner: 'upstream', repo: 'repo' },
        forkUrl: 'https://github.com/fork/repo',
        forkCreated: false,
        reason: 'sso_blocked',
      },
    });

    await launchTrackedCloudAgent({
      spaceId: 'space-1',
      prompt: 'full prompt',
      displayPrompt: 'display prompt',
      workspace: '/ws',
      personaHandle: 'reviewer',
    });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'agent-1',
      source: 'cca',
      prompt: 'display prompt',
      cca_job_id: 'job-1',
      cca_repository: 'upstream/repo',
      cca_effective_repository: 'fork/repo',
      cca_fallback_json: expect.stringContaining('sso_blocked'),
      cca_result_json: expect.stringContaining('job-1'),
    }));
  });
});
