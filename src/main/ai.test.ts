import { describe, it, expect, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import type { SandboxPolicy } from '../shared/ipc-contract';

// ai.ts indirectly imports electron via ./config. Mock before the import.
vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'whim-ai-test') },
}));

// The SDK is imported as values (CopilotClient etc.) at module top level.
// We never call them in these tests — provide stubs that satisfy the imports
// without dragging the real SDK into the test process.
vi.mock('@microsoft/copilot-sdk', () => ({
  CopilotClient: class {},
  CopilotSession: class {},
  RuntimeConnection: class {},
}));

vi.mock('./config', () => ({
  getConfigValue: vi.fn(() => null),
  setConfigValue: vi.fn(),
}));

vi.mock('./session', () => ({
  resolveCopilotCliPath: vi.fn(() => '/mock/cli'),
}));

import { previewSandboxConfig, buildRuntimeSandboxConfig } from './ai';

const basePolicy: SandboxPolicy = {
  scopeToSpaceFolder: true,
  extraReadwritePaths: [],
  extraReadonlyPaths: [],
  extraDeniedPaths: [],
  allowMcpServers: false,
  allowWebFetch: false,
  allowOutbound: false,
  allowLocalNetwork: false,
  enforcementMode: 'both',
};

describe('previewSandboxConfig / materializeRuntimeConfig shape', () => {
  // These tests exist primarily to lock the `sandbox.userPolicy.*` nesting
  // contract. A previous version of materializeRuntimeConfig wrote the policy
  // fields at `sandbox.filesystem` / `sandbox.network` directly. The runtime's
  // zod schema accepts that shape with passthrough but the policy loader reads
  // `userPolicy.filesystem` / `userPolicy.network` — so the whole policy was
  // silently ignored and every sandbox fell back to runtime defaults
  // (notably allowOutbound:true). The shape assertions below catch regressions.

  it('nests filesystem and network under sandbox.userPolicy (NOT directly under sandbox)', () => {
    const cfg = previewSandboxConfig(basePolicy) as any;

    // Positive: the userPolicy nesting must exist.
    expect(cfg.sandbox).toBeDefined();
    expect(cfg.sandbox.userPolicy).toBeDefined();
    expect(cfg.sandbox.userPolicy.filesystem).toBeDefined();
    expect(cfg.sandbox.userPolicy.network).toBeDefined();

    // Negative: the flat shape (the historical bug) must NOT be present.
    // If someone "cleans up" by hoisting filesystem/network up a level, this
    // test fails loudly instead of letting the policy silently no-op.
    expect(cfg.sandbox.filesystem).toBeUndefined();
    expect(cfg.sandbox.network).toBeUndefined();
  });

  it('marks the sandbox as enabled in the preview', () => {
    const cfg = previewSandboxConfig(basePolicy) as any;
    expect(cfg.sandbox.enabled).toBe(true);
  });

  it('includes the workspace placeholder in readwritePaths when scopeToSpaceFolder is true', () => {
    const cfg = previewSandboxConfig({
      ...basePolicy,
      scopeToSpaceFolder: true,
      extraReadwritePaths: [],
    }) as any;
    expect(cfg.sandbox.userPolicy.filesystem.readwritePaths).toEqual([
      '<space folder — replaced at agent launch>',
    ]);
  });

  it('omits the workspace placeholder when scopeToSpaceFolder is false', () => {
    const cfg = previewSandboxConfig({
      ...basePolicy,
      scopeToSpaceFolder: false,
      extraReadwritePaths: ['/extra/path'],
    }) as any;
    expect(cfg.sandbox.userPolicy.filesystem.readwritePaths).toEqual(['/extra/path']);
  });

  it('deduplicates extra readwrite paths against the workspace placeholder', () => {
    // If a user adds the workspace placeholder string explicitly into extras,
    // it should not appear twice. This guards against unbounded duplication
    // when a future caller passes an actual cwd into both scoped + extras.
    const cfg = previewSandboxConfig({
      ...basePolicy,
      scopeToSpaceFolder: true,
      extraReadwritePaths: ['<space folder — replaced at agent launch>', '/other'],
    }) as any;
    expect(cfg.sandbox.userPolicy.filesystem.readwritePaths).toEqual([
      '<space folder — replaced at agent launch>',
      '/other',
    ]);
  });

  it('copies extraReadonlyPaths and extraDeniedPaths into the filesystem block', () => {
    const cfg = previewSandboxConfig({
      ...basePolicy,
      extraReadonlyPaths: ['/ro1', '/ro2'],
      extraDeniedPaths: ['/secret'],
    }) as any;
    expect(cfg.sandbox.userPolicy.filesystem.readonlyPaths).toEqual(['/ro1', '/ro2']);
    expect(cfg.sandbox.userPolicy.filesystem.deniedPaths).toEqual(['/secret']);
  });

  it('always sets clearPolicyOnExit: true so policy is not persisted across runs', () => {
    const cfg = previewSandboxConfig(basePolicy) as any;
    expect(cfg.sandbox.userPolicy.filesystem.clearPolicyOnExit).toBe(true);
  });

  it('propagates allowOutbound: false into network.allowOutbound', () => {
    const cfg = previewSandboxConfig({ ...basePolicy, allowOutbound: false }) as any;
    expect(cfg.sandbox.userPolicy.network.allowOutbound).toBe(false);
  });

  it('propagates allowOutbound: true into network.allowOutbound', () => {
    const cfg = previewSandboxConfig({ ...basePolicy, allowOutbound: true }) as any;
    expect(cfg.sandbox.userPolicy.network.allowOutbound).toBe(true);
  });

  it('propagates allowLocalNetwork into network.allowLocalNetwork', () => {
    const denied = previewSandboxConfig({ ...basePolicy, allowLocalNetwork: false }) as any;
    const allowed = previewSandboxConfig({ ...basePolicy, allowLocalNetwork: true }) as any;
    expect(denied.sandbox.userPolicy.network.allowLocalNetwork).toBe(false);
    expect(allowed.sandbox.userPolicy.network.allowLocalNetwork).toBe(true);
  });

  it('does not mutate the input policy arrays (defensive copy)', () => {
    const policy: SandboxPolicy = {
      ...basePolicy,
      extraReadwritePaths: ['/rw'],
      extraReadonlyPaths: ['/ro'],
      extraDeniedPaths: ['/deny'],
    };
    previewSandboxConfig(policy);
    expect(policy.extraReadwritePaths).toEqual(['/rw']);
    expect(policy.extraReadonlyPaths).toEqual(['/ro']);
    expect(policy.extraDeniedPaths).toEqual(['/deny']);
  });

  it('produces a JSON-serializable object (no functions, classes, or circular refs)', () => {
    const cfg = previewSandboxConfig(basePolicy);
    expect(() => JSON.stringify(cfg)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(cfg));
    expect(roundTripped).toEqual(cfg);
  });
});

describe('buildRuntimeSandboxConfig', () => {
  // The runtime's options.update RPC takes the UNWRAPPED shape, NOT the
  // `{ sandbox: {...} }` wrapper that the FILE format uses. This is the
  // single most-easily-confused thing in the sandbox pipeline; locking it
  // here prevents a tweak to materializeRuntimeConfig from accidentally
  // re-wrapping the runtime payload (which would silently disable
  // enforcement, just like the original demo bug).

  it('returns the unwrapped shape (no `sandbox` wrapper key)', () => {
    const cfg = buildRuntimeSandboxConfig(true, '/tmp/work', basePolicy) as any;
    // Must NOT have the file-format wrapper.
    expect(cfg.sandbox).toBeUndefined();
    // Must have the top-level enabled / userPolicy keys the runtime expects.
    expect(cfg.enabled).toBe(true);
    expect(cfg.userPolicy).toBeDefined();
    expect(cfg.userPolicy.filesystem).toBeDefined();
    expect(cfg.userPolicy.network).toBeDefined();
  });

  it('respects enabled=false (used by disableSandboxForSession)', () => {
    const cfg = buildRuntimeSandboxConfig(false, '/tmp/work', basePolicy) as any;
    expect(cfg.enabled).toBe(false);
  });

  it('produces a payload accepted by session.rpc.options.update (JSON-serializable)', () => {
    const cfg = buildRuntimeSandboxConfig(true, '/tmp/work', basePolicy);
    expect(() => JSON.stringify(cfg)).not.toThrow();
  });
});
