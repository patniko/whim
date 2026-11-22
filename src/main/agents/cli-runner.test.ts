import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as os from 'os';

const { session, ahp, ai, sdkRunner, client } = vi.hoisted(() => {
  const client = {
    getAuthStatus: vi.fn(),
    rpc: { sessions: { releaseLock: vi.fn(async () => {}) } },
  };
  return {
    session: { launchCliInTerminal: vi.fn(async () => ({ pid: 1 })), launchSessionInTerminal: vi.fn(async () => ({ pid: 1 })) },
    ahp: { publishSessionForCli: vi.fn(async (_client: unknown, _workspace: string, sessionId: string) => ['--ahp', 'ws://h/?tkn=t', `--resume=${sessionId}`]) },
    ai: { getCopilotClient: vi.fn(() => client) },
    sdkRunner: { reviveAgent: vi.fn() },
    client,
  };
});

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../session', () => session);
vi.mock('../ahp-host', () => ahp);
vi.mock('../ai', () => ai);
vi.mock('./sdk-runner', () => sdkRunner);
vi.mock('../config', () => ({ getConfig: () => ({ workspace: '/work' }) }));
vi.mock('../storage', () => ({ getStorageGeneration: () => 0, withStorageGeneration: (_g: number, run: () => unknown) => run }));
vi.mock('../producer-tasks', () => ({ observeProducer: vi.fn() }));

import { initCliRunner, openAgentCli } from './cli-runner';

const records = new Map<string, Record<string, unknown>>();
const persisted = new Map<string, Record<string, unknown>>();
const workingDir = os.tmpdir();
const notifier = { notifyRenderer: vi.fn() };
const persistence = {
  getSession: async (id: string) => persisted.get(id) ?? null,
  updateStatus: vi.fn(async () => {}),
};

initCliRunner({
  registry: { get: (id: string) => records.get(id) } as never,
  notifier: notifier as never,
  persistence: persistence as never,
});

function saved(id: string, fields: Record<string, unknown> = {}): void {
  persisted.set(id, { id, session_id: `session-${id}`, working_dir: workingDir, source: 'sdk', run_location: 'local', ...fields });
}

describe('openAgentCli', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    records.clear();
    persisted.clear();
    client.getAuthStatus.mockResolvedValue({ isAuthenticated: true });
    // Mirrors sdk-runner: a live record is returned as is.
    sdkRunner.reviveAgent.mockImplementation(async (id: string) => {
      const record = records.get(id);
      return record ? { record, rebuilt: false, restarted: false } : null;
    });
  });

  it("attaches the bundled CLI to a live local session over Whim's AHP host", async () => {
    records.set('a1', { sessionId: 'live-1', runLocation: 'local', status: 'running' });
    saved('a1');

    await expect(openAgentCli('a1')).resolves.toEqual({});

    expect(ahp.publishSessionForCli).toHaveBeenCalledWith(client, '/work', 'live-1');
    expect(session.launchCliInTerminal).toHaveBeenCalledWith(['--ahp', 'ws://h/?tkn=t', '--resume=live-1'], workingDir);
    expect(client.rpc.sessions.releaseLock).not.toHaveBeenCalled();
    expect(records.get('a1')!.status).toBe('running');
    expect(persistence.updateStatus).not.toHaveBeenCalled();
  });

  it('brings back a stopped session as live and idle before attaching, using whichever session it resumed into', async () => {
    records.set('a2', { sessionId: 'stopped-2', runLocation: 'local', aborted: true });
    saved('a2');
    const rebuilt = { sessionId: 'restarted-2', status: 'failed', summary: 'Stopped' };
    sdkRunner.reviveAgent.mockResolvedValue({ record: rebuilt, rebuilt: true, restarted: true });

    await expect(openAgentCli('a2')).resolves.toEqual({});

    expect(sdkRunner.reviveAgent).toHaveBeenCalledWith('a2');
    // Otherwise Whim would refuse follow-ups to a session the CLI is driving.
    expect(rebuilt.status).toBe('completed');
    expect(persistence.updateStatus).toHaveBeenCalledWith(rebuilt);
    expect(notifier.notifyRenderer).toHaveBeenCalledWith('agent:status-changed', { agentId: 'a2', status: 'completed', summary: 'Stopped' });
    expect(ahp.publishSessionForCli).toHaveBeenCalledWith(client, '/work', 'restarted-2');
  });

  it('asks for a GitHub sign-in instead of starting a host that would refuse the CLI', async () => {
    records.set('a3', { sessionId: 'live-3', runLocation: 'local' });
    saved('a3');
    client.getAuthStatus.mockResolvedValue({ isAuthenticated: false });

    const result = await openAgentCli('a3');

    expect(result.error).toContain('Sign in to GitHub');
    expect(ahp.publishSessionForCli).not.toHaveBeenCalled();
    expect(session.launchCliInTerminal).not.toHaveBeenCalled();
  });

  it('lets the CLI resume a cloud session itself, since only local sessions can be published', async () => {
    saved('a4', { run_location: 'cloud' });

    await expect(openAgentCli('a4')).resolves.toEqual({});

    expect(client.rpc.sessions.releaseLock).toHaveBeenCalledWith({ sessionId: 'session-a4' });
    expect(session.launchSessionInTerminal).toHaveBeenCalledWith('session-a4', workingDir);
    expect(ahp.publishSessionForCli).not.toHaveBeenCalled();
  });

  it('leaves a session the CLI created to the CLI rather than reopening it in Whim', async () => {
    saved('a7', { source: 'cli' });

    await expect(openAgentCli('a7')).resolves.toEqual({});

    expect(session.launchSessionInTerminal).toHaveBeenCalledWith('session-a7', workingDir);
    expect(sdkRunner.reviveAgent).not.toHaveBeenCalled();
    expect(ahp.publishSessionForCli).not.toHaveBeenCalled();
  });

  it('explains why an ephemeral session cannot be opened', async () => {
    records.set('a5', { sessionId: 'mem-5', runLocation: 'local', ephemeral: true });

    const result = await openAgentCli('a5');

    expect(result.error).toContain('Ephemeral');
    expect(session.launchCliInTerminal).not.toHaveBeenCalled();
  });

  it('reports a session that could not be reopened', async () => {
    saved('a6');

    await expect(openAgentCli('a6')).resolves.toEqual({ error: 'Could not reopen this session.' });
    expect(session.launchCliInTerminal).not.toHaveBeenCalled();
  });
});
