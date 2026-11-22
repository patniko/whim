import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// ai.ts indirectly imports electron via ./config. Mock before the import.
vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'whim-ai-runtime-test'),
    getAppPath: () => '/whim/app.asar',
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

const spawned: { opts: Record<string, unknown>; started: number; stopped: number }[] = [];
const startupBehavior = vi.hoisted(() => ({ start: vi.fn(async () => {}), listModels: vi.fn(async (): Promise<unknown[]> => []) }));

// Identifiable connection stubs so tests can assert how the SDK was configured.
vi.mock('@microsoft/copilot-sdk', () => ({
  CopilotClient: class {
    private record: { opts: Record<string, unknown>; started: number; stopped: number };
    constructor(opts: Record<string, unknown>) {
      this.record = { opts, started: 0, stopped: 0 };
      spawned.push(this.record);
    }
    async start(): Promise<void> { this.record.started++; await startupBehavior.start(); }
    async stop(): Promise<Error[]> { this.record.stopped++; return []; }
    get rpc() { return { models: { list: async () => ({ models: await startupBehavior.listModels() }) } }; }
    async createSession(): Promise<unknown> { return { disconnect: async () => {} }; }
  },
  CopilotSession: class {},
  RuntimeConnection: {
    forInProcess: () => ({ kind: 'inprocess' }),
  },
}));

vi.mock('./config', () => ({
  getConfigValue: vi.fn(() => null),
  setConfigValue: vi.fn(),
}));

vi.mock('./ahp-host', () => ({
  disposeAhpHost: vi.fn(async () => {}),
}));

import {
  initCopilot,
  shutdownCopilot,
  ensureEphemeralCopilotClient,
  getEphemeralCopilotClient,
  getCopilotClient,
  listModelsDetailed,
  resetAfterAuthChange,
} from './ai';
import { disposeAhpHost } from './ahp-host';
import { getBundledSdkRuntimePaths } from './copilot-runtime-path';

const bundledRuntime = getBundledSdkRuntimePaths('/whim/app.asar');

function resetRuntimeMocks(): void {
  startupBehavior.start.mockReset().mockResolvedValue();
  startupBehavior.listModels.mockReset().mockResolvedValue([]);
  vi.mocked(fs.existsSync).mockReturnValue(true);
}

describe('client lifecycle', () => {
  beforeEach(async () => {
    await shutdownCopilot();
    vi.clearAllMocks();
    resetRuntimeMocks();
    spawned.length = 0;
  });

  it('starts exactly one in-process runtime on init and does not start the ephemeral client', async () => {
    await initCopilot();
    expect(spawned).toHaveLength(1);
    expect(getCopilotClient()).not.toBeNull();
    expect(getEphemeralCopilotClient()).toBeNull();
    expect(spawned[0].opts).toEqual({ mode: 'coding-agent', runtime: { kind: 'inprocess' } });
  });

  it('pins in-process startup to the unpacked bundled runtime, then restores the environment', async () => {
    vi.stubEnv('COPILOT_CLI_PATH', '/user/copilot');
    const seen: (string | undefined)[] = [];
    startupBehavior.start.mockImplementation(async () => { seen.push(process.env.COPILOT_CLI_PATH); });
    try {
      await initCopilot();
      await ensureEphemeralCopilotClient();
      expect(seen).toEqual([bundledRuntime.executable, bundledRuntime.executable]);
      expect(process.env.COPILOT_CLI_PATH).toBe('/user/copilot');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses in-process for primary and ephemeral clients without subprocess options', async () => {
    const originalEnv = { ...process.env };
    await initCopilot();
    await ensureEphemeralCopilotClient();
    expect(spawned).toHaveLength(2);
    for (const record of spawned) {
      expect(record.opts.mode).toBe('coding-agent');
      expect(record.opts.runtime).toEqual({ kind: 'inprocess' });
      expect(record.opts.env).toBeUndefined();
      expect(record.opts.workingDirectory).toBeUndefined();
    }
    expect(spawned[1].opts.sessionFs).toMatchObject({ conventions: 'posix' });
    expect(process.env).toEqual(originalEnv);
  });

  it('does not launch a runtime when its bundled library is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await initCopilot();
    expect(spawned).toHaveLength(0);
    expect(getCopilotClient()).toBeNull();
  });

  it('coalesces concurrent initCopilot() calls into one spawn', async () => {
    let release!: () => void;
    startupBehavior.start.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const starts = [initCopilot(), initCopilot(), initCopilot()];
    const completed = vi.fn();
    void Promise.all(starts).then(completed);
    try {
      await vi.waitFor(() => expect(startupBehavior.start).toHaveBeenCalledTimes(1));
      expect(spawned).toHaveLength(1);
      expect(completed).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await Promise.all(starts);
    expect(spawned).toHaveLength(1);
    expect(getCopilotClient()).not.toBeNull();
  });

  it('reuses an already initialized client', async () => {
    await initCopilot();
    await initCopilot();
    expect(spawned).toHaveLength(1);
  });

  it('releases a failed native startup', async () => {
    startupBehavior.start.mockRejectedValueOnce(new Error('native startup failed'));
    await initCopilot();
    expect(getCopilotClient()).toBeNull();
    expect(spawned[0].stopped).toBe(1);
  });

  it('starts the ephemeral client lazily and reuses it afterwards', async () => {
    await initCopilot();
    const a = await ensureEphemeralCopilotClient();
    const b = await ensureEphemeralCopilotClient();
    expect(a).toBe(b);
    expect(spawned).toHaveLength(2);
  });

  it('coalesces concurrent ephemeral starts into one spawn', async () => {
    await initCopilot();
    let release!: () => void;
    startupBehavior.start.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const starts = [ensureEphemeralCopilotClient(), ensureEphemeralCopilotClient()];
    try {
      await vi.waitFor(() => expect(startupBehavior.start).toHaveBeenCalledTimes(2));
      expect(spawned).toHaveLength(2);
      expect(getEphemeralCopilotClient()).toBeNull();
    } finally {
      release();
    }
    const [a, b] = await Promise.all(starts);
    expect(a).toBe(b);
    expect(spawned).toHaveLength(2);
  });

  it('restarts the ephemeral client and AHP host after the account changes, keeping the primary', async () => {
    await initCopilot();
    const primary = getCopilotClient();
    await ensureEphemeralCopilotClient();
    await resetAfterAuthChange();
    expect(getCopilotClient()).toBe(primary);
    expect(spawned[1].stopped).toBe(1);
    expect(getEphemeralCopilotClient()).toBeNull();
    expect(disposeAhpHost).toHaveBeenCalled();
    await ensureEphemeralCopilotClient();
    expect(spawned).toHaveLength(3);
  });

  it('asks for a GitHub sign-in when the runtime is signed out', async () => {
    startupBehavior.listModels.mockRejectedValue(new Error('Not authenticated. Please authenticate first.'));
    await expect(listModelsDetailed()).resolves.toEqual({ models: [], error: 'Sign in to GitHub to load models.' });
  });

  it("lists the current account's models rather than the first answer it got", async () => {
    startupBehavior.listModels.mockResolvedValueOnce([{ id: 'old-model', name: 'Old' }]);
    await expect(listModelsDetailed()).resolves.toMatchObject({ models: [{ id: 'old-model' }] });
    startupBehavior.listModels.mockRejectedValueOnce(new Error('Not authenticated. Please authenticate first.'));
    await expect(listModelsDetailed()).resolves.toMatchObject({ models: [], error: 'Sign in to GitHub to load models.' });
    startupBehavior.listModels.mockResolvedValueOnce([{ id: 'new-model', name: 'New' }]);
    await expect(listModelsDetailed()).resolves.toMatchObject({ models: [{ id: 'new-model' }] });
  });
});
