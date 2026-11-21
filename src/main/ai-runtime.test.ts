import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
const startupBehavior = vi.hoisted(() => ({ start: vi.fn(async () => {}) }));

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
    async getStatus(): Promise<unknown> { return { version: '1.0.83', protocolVersion: 2 }; }
    async listModels(): Promise<unknown[]> { return []; }
    async createSession(): Promise<unknown> { return { disconnect: async () => {} }; }
  },
  CopilotSession: class {},
  RuntimeConnection: {
    forSpawnedStdio: (opts?: Record<string, unknown>) => ({ kind: 'spawned-stdio', ...opts }),
    forTcp: (host: string, port: number, opts?: { connectionToken?: string }) => ({ kind: 'tcp', host, port, connectionToken: opts?.connectionToken }),
    forInProcess: () => ({ kind: 'inprocess' }),
  },
}));

vi.mock('./config', () => ({
  getConfigValue: vi.fn(() => null),
  setConfigValue: vi.fn(),
}));

vi.mock('./cli-electron-shim', () => ({
  getCliShimPath: vi.fn(() => null),
}));

vi.mock('./session', () => ({
  resolveCopilotCliPath: vi.fn(() => '/mock/cli'),
  resolveBundledCliPath: vi.fn(() => '/bundled/@github/copilot/index.js'),
  resolveAutoDetectedCliPath: vi.fn(() => null),
  resolveConfiguredCliPath: vi.fn((p: string | null) => p || null),
  probeCliVersion: vi.fn(() => '1.0.71'),
  MIN_CLI_VERSION: '1.0.71',
  compareVersions: (a: string, b: string): number => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  },
}));

import {
  resolveRuntimeConnection,
  parseRuntimeServerAddress,
  getRuntimeStatus,
  initCopilot,
  reinitCopilot,
  shutdownCopilot,
  scheduleCopilotReinit,
  ensureEphemeralCopilotClient,
  getEphemeralCopilotClient,
  getCopilotClient,
  testRuntimeConnection,
  MIN_SDK_RUNTIME_VERSION,
} from './ai';
import { getConfigValue } from './config';
import { resolveAutoDetectedCliPath, resolveConfiguredCliPath, probeCliVersion } from './session';
import { getBundledSdkRuntimePaths } from './copilot-runtime-path';

const mockGetConfigValue = vi.mocked(getConfigValue);
const bundledRuntime = getBundledSdkRuntimePaths('/whim/app.asar');

/** Drive cliSource/cliServerUrl/cliServerToken/cliPath from a plain object. */
function withConfig(values: Record<string, unknown>): void {
  mockGetConfigValue.mockImplementation((key: string) => (key in values ? values[key] : null) as never);
}

function resetSessionMocks(): void {
  startupBehavior.start.mockReset().mockResolvedValue();
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(resolveConfiguredCliPath).mockImplementation(p => p || null);
  vi.mocked(resolveAutoDetectedCliPath).mockReturnValue(null);
  vi.mocked(probeCliVersion).mockReturnValue('1.0.71');
}

describe('resolveRuntimeConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionMocks();
  });

  it('hosts the unpacked native SDK runtime in-process when cliSource is unset', () => {
    withConfig({});
    expect(resolveRuntimeConnection()).toEqual({
      kind: 'bundled',
      target: bundledRuntime.executable,
      connection: { kind: 'inprocess' },
    });
  });

  it('only spawns the bundled runtime over stdio when explicitly configured', () => {
    withConfig({ cliSource: 'stdio', cliPath: '/ignored/cli' });
    expect(resolveRuntimeConnection()).toEqual({
      kind: 'stdio',
      target: bundledRuntime.executable,
      connection: { kind: 'spawned-stdio', path: bundledRuntime.executable },
    });
  });

  it.each(['bundled', 'stdio'])('reports missing native assets for %s without selecting another runtime', source => {
    withConfig({ cliSource: source });
    vi.mocked(fs.existsSync).mockImplementation(p => String(p) !== bundledRuntime.library);
    expect(resolveRuntimeConnection().target).toBeNull();
    expect(getRuntimeStatus().compatible).toBe(false);
  });

  it("attaches to a remote server over TCP when cliSource='server'", () => {
    withConfig({ cliSource: 'server', cliServerUrl: 'http://localhost:9001', cliServerToken: 'secret' });
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('server');
    expect(r.target).toBe('http://localhost:9001');
    expect(r.connection).toEqual({ kind: 'tcp', host: 'localhost', port: 9001, connectionToken: 'secret' });
  });

  it('omits the token when none is configured for a server', () => {
    withConfig({ cliSource: 'server', cliServerUrl: 'localhost:9001' });
    const r = resolveRuntimeConnection();
    expect(r.connection).toEqual({ kind: 'tcp', host: 'localhost', port: 9001, connectionToken: undefined });
  });

  it('keeps a malformed server address selected and reports why it cannot connect', () => {
    withConfig({ cliSource: 'server', cliServerUrl: 'localhost' });
    const r = resolveRuntimeConnection();
    expect(r).toMatchObject({ kind: 'server', target: 'localhost', connection: null });
    expect(r.error).toContain('Invalid remote runtime address');
    expect(getRuntimeStatus().compatible).toBe(false);
  });

  it('falls back to bundled when server source has no URL', () => {
    withConfig({ cliSource: 'server', cliServerUrl: null });
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('bundled');
    expect(r.target).toBe(bundledRuntime.executable);
  });

  it("uses the explicit configured path when cliSource='path'", () => {
    withConfig({ cliSource: 'path', cliPath: '/usr/local/bin/copilot' });
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('path');
    expect(r.target).toBe('/usr/local/bin/copilot');
    expect(r.connection).toEqual({
      kind: 'spawned-stdio',
      path: '/usr/local/bin/copilot',
      env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
    });
  });

  it("auto-detects the local CLI when cliSource='auto'", () => {
    vi.mocked(resolveAutoDetectedCliPath).mockReturnValue('/auto/detected/copilot');
    withConfig({ cliSource: 'auto' });
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('auto');
    expect(r.target).toBe('/auto/detected/copilot');
  });

  it('falls back to bundled when auto-detect finds nothing', () => {
    vi.mocked(resolveAutoDetectedCliPath).mockReturnValue(null);
    withConfig({ cliSource: 'auto' });
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('bundled');
  });
});

describe('parseRuntimeServerAddress', () => {
  it.each([
    ['localhost:9001', 'localhost', 9001],
    ['http://127.0.0.1:3000/', '127.0.0.1', 3000],
    ['https://runtime.example:8443', 'runtime.example', 8443],
    ['[::1]:9001', '::1', 9001],
    ['9001', 'localhost', 9001],
    [':9001', 'localhost', 9001],
  ])('accepts the SDK 1.x address form %s', (address, host, port) => {
    expect(parseRuntimeServerAddress(address)).toEqual({ host, port });
  });

  it.each(['localhost', 'localhost:0', 'localhost:65536', 'a:b:9001', 'localhost:port'])('rejects %s', address => {
    expect(() => parseRuntimeServerAddress(address)).toThrow('Invalid remote runtime address');
  });
});

describe('getRuntimeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionMocks();
  });

  it('accepts the pinned native bundle without a CLI --version probe', () => {
    withConfig({});
    const s = getRuntimeStatus();
    expect(s.source).toBe('bundled');
    expect(s.compatible).toBe(true);
    expect(s.minVersion).toBe(MIN_SDK_RUNTIME_VERSION);
    expect(probeCliVersion).not.toHaveBeenCalled();
  });

  it.each([['1.0.112', false], ['1.0.113', true]])('requires SDK protocol 4 from a local CLI (%s compatible=%s)', (version, compatible) => {
    vi.mocked(probeCliVersion).mockReturnValue(version);
    withConfig({ cliSource: 'path', cliPath: '/old/copilot' });
    const s = getRuntimeStatus();
    expect(s.version).toBe(version);
    expect(s.compatible).toBe(compatible);
  });

  it('does not probe a version for a remote server but stays compatible when a URL is set', () => {
    withConfig({ cliSource: 'server', cliServerUrl: 'localhost:9001' });
    const s = getRuntimeStatus();
    expect(s.source).toBe('server');
    expect(s.version).toBeNull();
    expect(s.compatible).toBe(true);
    expect(probeCliVersion).not.toHaveBeenCalled();
  });
});

describe('client lifecycle', () => {
  beforeEach(async () => {
    await shutdownCopilot();
    vi.clearAllMocks();
    resetSessionMocks();
    withConfig({});
    spawned.length = 0;
  });

  it('starts exactly one in-process runtime on init and does not start the ephemeral client', async () => {
    await initCopilot();
    expect(spawned).toHaveLength(1);
    expect(getCopilotClient()).not.toBeNull();
    expect(getEphemeralCopilotClient()).toBeNull();
    expect(spawned[0].opts).toEqual({ mode: 'coding-agent', runtime: { kind: 'inprocess' } });
    expect(getRuntimeStatus().version).toBe('1.0.83');
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

  it('preserves Electron-as-Node for custom CLI children', async () => {
    withConfig({ cliSource: 'path', cliPath: '/custom/index.js' });
    await initCopilot();
    expect(spawned[0].opts.runtime).toMatchObject({
      kind: 'spawned-stdio',
      path: '/custom/index.js',
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('does not launch a runtime when its bundled library is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await initCopilot();
    expect(spawned).toHaveLength(0);
    expect(getCopilotClient()).toBeNull();
  });

  it('does not launch a client for a malformed server address', async () => {
    withConfig({ cliSource: 'server', cliServerUrl: 'localhost' });
    await initCopilot();
    expect(spawned).toHaveLength(0);
    expect(getCopilotClient()).toBeNull();
    const result = await testRuntimeConnection(5_000);
    expect(result).toMatchObject({ ok: false, source: 'server', compatible: false });
    expect(result.error).toContain('Invalid remote runtime address');
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

  it('skips reinit when the resolved runtime is unchanged', async () => {
    await initCopilot();
    await reinitCopilot();
    expect(spawned).toHaveLength(1);
  });

  it('reinits when the resolved runtime changes', async () => {
    await initCopilot();
    withConfig({ cliSource: 'path', cliPath: '/other/copilot' });
    await reinitCopilot();
    expect(spawned).toHaveLength(2);
    expect(getCopilotClient()).not.toBeNull();
    expect(spawned[0].stopped).toBe(1);
  });

  it('stops both clients when switching from in-process to stdio', async () => {
    await initCopilot();
    await ensureEphemeralCopilotClient();
    withConfig({ cliSource: 'stdio' });
    await reinitCopilot();
    expect(spawned).toHaveLength(3);
    expect(spawned.slice(0, 2).map(record => record.stopped)).toEqual([1, 1]);
    expect(spawned[2].opts.runtime).toEqual({ kind: 'spawned-stdio', path: bundledRuntime.executable });
  });

  it('reinits when forced even if the runtime is unchanged', async () => {
    await initCopilot();
    await reinitCopilot(true);
    expect(spawned).toHaveLength(2);
  });

  it('reuses the live client for a connection test on the active runtime', async () => {
    await initCopilot();
    const result = await testRuntimeConnection(5_000);
    expect(result.ok).toBe(true);
    expect(spawned).toHaveLength(1);
  });

  it('spawns a throwaway client when testing a runtime that is not live', async () => {
    await initCopilot();
    withConfig({ cliSource: 'server', cliServerUrl: 'http://localhost:9001' });
    const result = await testRuntimeConnection(5_000);
    expect(result.ok).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(spawned[1].opts).toEqual({
      mode: 'coding-agent',
      runtime: { kind: 'tcp', host: 'localhost', port: 9001, connectionToken: undefined },
    });
    expect(spawned[1].stopped).toBe(1);
  });

  it('can test in-process without passing env or leaving its host running', async () => {
    const result = await testRuntimeConnection();
    expect(result).toMatchObject({ ok: true, source: 'bundled', version: '1.0.83' });
    expect(spawned[0].opts).toEqual({ mode: 'coding-agent', runtime: { kind: 'inprocess' } });
    expect(spawned[0].stopped).toBe(1);
  });

  it('cleans up an in-process test that finishes startup after its timeout', async () => {
    let release!: () => void;
    startupBehavior.start.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const result = await testRuntimeConnection(5);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    expect(spawned[0].stopped).toBe(0);
    release();
    await vi.waitFor(() => expect(spawned[0].stopped).toBe(1));
  });
});

describe('scheduleCopilotReinit', () => {
  beforeEach(async () => {
    await shutdownCopilot();
    resetSessionMocks();
    withConfig({});
    spawned.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('collapses a burst of settings writes into a single respawn', async () => {
    await initCopilot();
    expect(spawned).toHaveLength(1);

    // Mimics the settings UI writing cliPath then cliSource back to back.
    const first = scheduleCopilotReinit();
    withConfig({ cliSource: 'path', cliPath: '/other/copilot' });
    const pending = scheduleCopilotReinit();

    await vi.advanceTimersByTimeAsync(600);
    await pending;
    await first;
    expect(spawned).toHaveLength(2);
  });
});
