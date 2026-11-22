import { beforeEach, describe, expect, it, vi } from 'vitest';

const { config } = vi.hoisted(() => ({ config: { ahpComputeId: null as string | null } }));

vi.mock('./config', () => ({
  getConfigValue: vi.fn((key: 'ahpComputeId') => config[key]),
  setConfigValue: vi.fn((key: 'ahpComputeId', value: string) => { config[key] = value; }),
}));

import { ahpAttachArgs, disposeAhpHost, ensureAhpHost, publishSessionForCli } from './ahp-host';
import { setConfigValue } from './config';

type Options = Parameters<import('@microsoft/copilot-sdk').CopilotClient['startAhpHost']>[0];

function fakeHost(id: string) {
  return {
    hostId: id,
    url: 'ws://127.0.0.1:4100/',
    token: 'a1b2',
    dispose: vi.fn(async () => {}),
    publishSession: vi.fn(async (sessionId: string) => ({ sessionId })),
  };
}

function fakeClient() {
  const starts: Options[] = [];
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const client = {
    startAhpHost: vi.fn(async (options: Options) => {
      starts.push(options);
      const host = fakeHost(`host-${hosts.length + 1}`);
      hosts.push(host);
      return host;
    }),
  };
  return { client: client as unknown as import('@microsoft/copilot-sdk').CopilotClient, raw: client, starts, hosts };
}

describe('ahp-host', () => {
  beforeEach(async () => {
    await disposeAhpHost();
    config.ahpComputeId = null;
    vi.clearAllMocks();
  });

  it('starts a loopback host that admits only the signed-in GitHub account and serves the workspace', async () => {
    const { client, starts } = fakeClient();
    await ensureAhpHost(client, '/work');
    expect(starts[0]).toMatchObject({
      localServer: {},
      authentication: { mode: 'github' },
      workspace: '/work',
      allowCreatingNewSessions: false,
    });
  });

  it('keeps one persisted catalog identity of its own', async () => {
    const { client, starts } = fakeClient();
    await ensureAhpHost(client, '/work');
    await ensureAhpHost(client, '/other');
    expect(starts[0].computeId).toMatch(/^whim-[0-9a-f-]{36}$/);
    expect(starts[1].computeId).toBe(starts[0].computeId);
    expect(setConfigValue).toHaveBeenCalledTimes(1);
  });

  it('reuses the host for the same client and workspace and replaces it when either changes', async () => {
    const first = fakeClient();
    const a = await ensureAhpHost(first.client, '/work');
    expect(await ensureAhpHost(first.client, '/work')).toBe(a);
    const b = await ensureAhpHost(first.client, '/other');
    expect(first.hosts[0].dispose).toHaveBeenCalled();
    const second = fakeClient();
    await ensureAhpHost(second.client, '/other');
    expect(first.hosts[1].dispose).toHaveBeenCalled();
    expect(b).not.toBe(a);
  });

  it('ignores a late exit report from a start that failed', async () => {
    const { client, raw } = fakeClient();
    let failed: Options | undefined;
    raw.startAhpHost.mockImplementationOnce(async (options: Options) => {
      failed = options;
      throw new Error('catalog in use');
    });
    await expect(ensureAhpHost(client, '/work')).rejects.toThrow('catalog in use');
    const live = await ensureAhpHost(client, '/work');
    failed!.onExit?.({ hostId: 'failed', reason: 'exited', error: 'catalog in use' } as never);
    expect(await ensureAhpHost(client, '/work')).toBe(live);
  });

  it('forgets a host that exits so the next attach starts a new one', async () => {
    const { client, starts } = fakeClient();
    const first = await ensureAhpHost(client, '/work');
    starts[0].onExit?.({ hostId: first.hostId, reason: 'exited' } as never);
    expect(await ensureAhpHost(client, '/work')).not.toBe(first);
  });

  it('stops a host whose start was still in flight when it was disposed', async () => {
    const { client, raw, hosts } = fakeClient();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = raw.startAhpHost.getMockImplementation()!;
    raw.startAhpHost.mockImplementationOnce(async (options: Options) => {
      await gate;
      return original(options);
    });

    const pending = ensureAhpHost(client, '/work');
    await vi.waitFor(() => expect(raw.startAhpHost).toHaveBeenCalled());
    await disposeAhpHost();
    release();

    await expect(pending).rejects.toThrow('stopped while it was starting');
    expect(hosts[0].dispose).toHaveBeenCalled();
    const next = await ensureAhpHost(client, '/work');
    expect(next).toBe(hosts[1]);
  });

  it('publishes the session and returns CLI arguments that attach to it', async () => {
    const { client, hosts } = fakeClient();
    const args = await publishSessionForCli(client, '/work', 'session-1');
    expect(hosts[0].publishSession).toHaveBeenCalledWith('session-1');
    expect(args).toEqual(['--ahp', 'ws://127.0.0.1:4100/?tkn=a1b2', '--ahp-authenticate', 'github', '--resume=session-1']);
  });

  it('encodes the connection token and omits it when the listener needs none', () => {
    expect(ahpAttachArgs({ url: 'ws://h/', token: 'a b' }, 's')[1]).toBe('ws://h/?tkn=a%20b');
    expect(ahpAttachArgs({ url: 'ws://h/', token: undefined }, 's')[1]).toBe('ws://h/');
  });
});
