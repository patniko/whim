import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// ai.ts indirectly imports electron via ./config. Mock before the import.
vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'whim-ai-runtime-test') },
}));

// Identifiable connection stubs so tests can assert how the SDK was configured.
vi.mock('@github/copilot-sdk', () => ({
  CopilotClient: class {
    async start(): Promise<void> {}
    async stop(): Promise<Error[]> { return []; }
    async listModels(): Promise<unknown[]> { return []; }
  },
  CopilotSession: class {},
  RuntimeConnection: {
    forStdio: (opts: { path?: string }) => ({ kind: 'stdio', path: opts?.path }),
    forUri: (url: string, opts?: { connectionToken?: string }) => ({ kind: 'uri', url, connectionToken: opts?.connectionToken }),
    forTcp: (opts: unknown) => ({ kind: 'tcp', opts }),
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

import { resolveRuntimeConnection, getRuntimeStatus } from './ai';
import { getConfigValue } from './config';
import { resolveAutoDetectedCliPath, resolveConfiguredCliPath, probeCliVersion } from './session';

const mockGetConfigValue = vi.mocked(getConfigValue);

/** Drive cliSource/cliServerUrl/cliServerToken/cliPath from a plain object. */
function withConfig(values: Record<string, unknown>): void {
  mockGetConfigValue.mockImplementation((key: string) => (key in values ? values[key] : null) as never);
}

function resetSessionMocks(): void {
  vi.mocked(resolveConfiguredCliPath).mockImplementation((p: string | null) => p || null);
  vi.mocked(resolveAutoDetectedCliPath).mockReturnValue(null);
  vi.mocked(probeCliVersion).mockReturnValue('1.0.71');
}

describe('resolveRuntimeConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionMocks();
  });

  it('defaults to the bundled CLI when cliSource is unset', () => {
    withConfig({});
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('bundled');
    expect(r.target).toBe('/bundled/@github/copilot/index.js');
    expect(r.connection).toEqual({ kind: 'stdio', path: '/bundled/@github/copilot/index.js' });
  });

  it("connects to a remote server via forUri when cliSource='server'", () => {
    withConfig({ cliSource: 'server', cliServerUrl: 'http://localhost:9001', cliServerToken: 'secret' });
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('server');
    expect(r.target).toBe('http://localhost:9001');
    expect(r.connection).toEqual({ kind: 'uri', url: 'http://localhost:9001', connectionToken: 'secret' });
  });

  it('omits the token when none is configured for a server', () => {
    withConfig({ cliSource: 'server', cliServerUrl: 'localhost:9001' });
    const r = resolveRuntimeConnection();
    expect(r.connection).toEqual({ kind: 'uri', url: 'localhost:9001', connectionToken: undefined });
  });

  it('falls back to bundled when server source has no URL', () => {
    withConfig({ cliSource: 'server', cliServerUrl: null });
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('bundled');
    expect(r.target).toBe('/bundled/@github/copilot/index.js');
  });

  it("uses the explicit configured path when cliSource='path'", () => {
    withConfig({ cliSource: 'path', cliPath: '/usr/local/bin/copilot' });
    const r = resolveRuntimeConnection();
    expect(r.kind).toBe('path');
    expect(r.target).toBe('/usr/local/bin/copilot');
    expect(r.connection).toEqual({ kind: 'stdio', path: '/usr/local/bin/copilot' });
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

describe('getRuntimeStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionMocks();
  });

  it('reports the bundled CLI version and compatibility', () => {
    withConfig({});
    const s = getRuntimeStatus();
    expect(s.source).toBe('bundled');
    expect(s.version).toBe('1.0.71');
    expect(s.compatible).toBe(true);
    expect(s.minVersion).toBe('1.0.71');
  });

  it('marks an old local version as incompatible', () => {
    vi.mocked(probeCliVersion).mockReturnValue('1.0.10');
    withConfig({ cliSource: 'path', cliPath: '/old/copilot' });
    const s = getRuntimeStatus();
    expect(s.version).toBe('1.0.10');
    expect(s.compatible).toBe(false);
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
