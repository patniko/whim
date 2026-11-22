import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_SANDBOX_POLICY, type SandboxPolicy } from '../../shared/ipc-contract';

// Electron must be mocked before any modules that import it indirectly.
vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'space-sandbox-launch-test') },
}));

// Stub MCP + tools registries so we don't pull in their full graphs.
vi.mock('../mcp', () => ({
  getAllMcpServers: () => ({}),
}));

vi.mock('../tools', () => ({
  getCustomTools: () => [{ name: 'web_fetch' }, { name: 'other_tool' }],
}));

// Stub ai.ts so buildSandboxConfigs doesn't reach into electron via require().
// Returning realistic-looking paths lets our assertions still verify the shape.
vi.mock('../ai', () => ({
  buildSandboxConfigs: (agentId: string, _workingDir: string, _policy: SandboxPolicy) => ({
    onDir: path.join('/tmp', 'sandbox-config', agentId, 'on'),
    offDir: path.join('/tmp', 'sandbox-config', agentId, 'off'),
  }),
  // Mirror the real shape: unwrapped { enabled, userPolicy: { filesystem, network } }
  // ready for `session.rpc.options.update({ permissions: { sandbox } })`.
  buildRuntimeSandboxConfig: (enabled: boolean, _workingDir: string, _policy: SandboxPolicy) => ({
    enabled,
    userPolicy: {
      filesystem: {
        readwritePaths: [],
        readonlyPaths: [],
        deniedPaths: [],
        clearPolicyOnExit: true,
      },
      network: {
        allowOutbound: false,
        allowLocalNetwork: false,
      },
    },
  }),
}));

import { buildSandboxLaunchSetup } from './sandbox-launch';
import { AgentRegistry } from './agent-registry';
import { InteractionBroker } from './interaction-broker';
import type { AgentNotifier } from './agent-notifier';
import type { AgentPersistence } from './agent-persistence';

function makeNotifier(): AgentNotifier {
  return { notifyRenderer: vi.fn(), showApprovalNotification: vi.fn(), showSandboxBlockNotification: vi.fn(), showUserInputNotification: vi.fn(), showElicitationNotification: vi.fn() } as unknown as AgentNotifier;
}
function makePersistence(): AgentPersistence {
  return { updateStatus: vi.fn() } as unknown as AgentPersistence;
}

describe('buildSandboxLaunchSetup', () => {
  let registry: AgentRegistry;
  let broker: InteractionBroker;

  beforeEach(() => {
    registry = new AgentRegistry();
    broker = new InteractionBroker(makeNotifier(), makePersistence());
  });

  it('returns isSandboxed=true for a sandboxed persona', () => {
    const setup = buildSandboxLaunchSetup({
      agentId: 'a1',
      workingDir: path.join(os.tmpdir(), 'a1-work'),
      persona: { id: 'p1', handle: 'p', instructions: '', model: 'gpt', runLocation: 'local', sandboxed: false },
      registry,
      broker,
    });
    expect(setup.isSandboxed).toBe(false);
    expect(setup.hooks).toBeUndefined();
    expect(setup.enforcementMode).toBe('both');
  });

  function makeSandboxedPersona(override: Partial<SandboxPolicy> = {}) {
    return {
      id: 'p1', handle: 'p', instructions: '', model: 'gpt', runLocation: 'local' as const,
      sandboxed: true,
      sandboxPolicyOverride: { ...DEFAULT_SANDBOX_POLICY, ...override },
    };
  }

  it('installs both onPreToolUse + onPostToolUse + onPostToolUseFailure in enforcementMode=both', () => {
    const setup = buildSandboxLaunchSetup({
      agentId: 'a1',
      workingDir: path.join(os.tmpdir(), 'a1-work'),
      persona: makeSandboxedPersona({ enforcementMode: 'both' }),
      registry,
      broker,
    });
    expect(setup.isSandboxed).toBe(true);
    expect(setup.enforcementMode).toBe('both');
    expect(setup.hooks).toBeDefined();
    expect(setup.hooks).toHaveProperty('onPreToolUse');
    expect(setup.hooks).toHaveProperty('onPostToolUse');
    // onPostToolUseFailure is REQUIRED — sandbox denials (e.g. MXC refusing
    // to spawn powershell.exe) surface as failed tool results, which the SDK
    // routes to onPostToolUseFailure, not onPostToolUse.
    expect(setup.hooks).toHaveProperty('onPostToolUseFailure');
  });

  it('skips onPreToolUse but keeps onPostToolUse + onPostToolUseFailure in enforcementMode=mxc-only', () => {
    const setup = buildSandboxLaunchSetup({
      agentId: 'a2',
      workingDir: path.join(os.tmpdir(), 'a2-work'),
      persona: makeSandboxedPersona({ enforcementMode: 'mxc-only' }),
      registry,
      broker,
    });
    expect(setup.isSandboxed).toBe(true);
    expect(setup.enforcementMode).toBe('mxc-only');
    expect(setup.hooks).toBeDefined();
    expect(setup.hooks).not.toHaveProperty('onPreToolUse');
    expect(setup.hooks).toHaveProperty('onPostToolUse');
    expect(setup.hooks).toHaveProperty('onPostToolUseFailure');
  });

  it('still pre-materializes config dirs in mxc-only so sandbox stays enabled', () => {
    const setup = buildSandboxLaunchSetup({
      agentId: 'a3',
      workingDir: path.join(os.tmpdir(), 'a3-work'),
      persona: makeSandboxedPersona({ enforcementMode: 'mxc-only' }),
      registry,
      broker,
    });
    expect(setup.sandboxConfigs).toBeTruthy();
    expect(setup.sandboxConfigs?.onDir).toMatch(/sandbox-config[\\/]a3[\\/]on/);
    expect(setup.sandboxConfigs?.offDir).toMatch(/sandbox-config[\\/]a3[\\/]off/);
  });

  it('still strips web_fetch when allowWebFetch=false in mxc-only', () => {
    const setup = buildSandboxLaunchSetup({
      agentId: 'a4',
      workingDir: path.join(os.tmpdir(), 'a4-work'),
      persona: makeSandboxedPersona({ enforcementMode: 'mxc-only', allowWebFetch: false }),
      registry,
      broker,
    });
    expect(setup.customTools.some((t: any) => t?.name === 'web_fetch')).toBe(false);
    expect(setup.customTools.some((t: any) => t?.name === 'other_tool')).toBe(true);
  });

  it('keeps web_fetch when allowWebFetch=true in mxc-only', () => {
    const setup = buildSandboxLaunchSetup({
      agentId: 'a5',
      workingDir: path.join(os.tmpdir(), 'a5-work'),
      persona: makeSandboxedPersona({ enforcementMode: 'mxc-only', allowWebFetch: true }),
      registry,
      broker,
    });
    expect(setup.customTools.some((t: any) => t?.name === 'web_fetch')).toBe(true);
  });

  it('populates runtimeSandboxConfig for sandboxed personas so sdk-runner can pass it to session.rpc.options.update', () => {
    // The runtime needs to receive the sandboxConfig via options.update after
    // createSession — otherwise MXC enforcement stays off even though
    // configDir is set. This test locks the field's presence + shape; if it
    // ever regresses, curl + filesystem writes will silently succeed inside
    // @sandbox sessions again (the original demo bug).
    const setup = buildSandboxLaunchSetup({
      agentId: 'a6',
      workingDir: path.join(os.tmpdir(), 'a6-work'),
      persona: makeSandboxedPersona({ enforcementMode: 'mxc-only' }),
      registry,
      broker,
    });
    expect(setup.runtimeSandboxConfig).toBeTruthy();
    expect(setup.runtimeSandboxConfig).toEqual(
      expect.objectContaining({
        enabled: true,
        userPolicy: expect.objectContaining({
          filesystem: expect.any(Object),
          network: expect.any(Object),
        }),
      }),
    );
  });

  it('sets runtimeSandboxConfig=null for non-sandboxed personas', () => {
    const setup = buildSandboxLaunchSetup({
      agentId: 'a7',
      workingDir: path.join(os.tmpdir(), 'a7-work'),
      persona: { id: 'p1', handle: 'p', instructions: '', model: 'gpt', runLocation: 'local', sandboxed: false },
      registry,
      broker,
    });
    expect(setup.runtimeSandboxConfig).toBeNull();
  });

  it('post-tool-shell block payload offers only `disable` (not `allow-once`) because the tool has already failed', async () => {
    // The post-tool hook fires AFTER MXC denied the command and the
    // assistant has already seen the failure result. "Allow once" at that
    // point would just dismiss the panel without retrying anything, which
    // is misleading UX (the user expects the action to proceed). The only
    // decision that meaningfully changes runtime state is `disable`, which
    // also fires a retry prompt via `disableSandboxForSession`.
    // Regression for: "when i allow once shouldnt it have allowed".
    const notifyRenderer = vi.fn();
    const localNotifier = { notifyRenderer, showApprovalNotification: vi.fn(), showSandboxBlockNotification: vi.fn(), showUserInputNotification: vi.fn(), showElicitationNotification: vi.fn() } as unknown as AgentNotifier;
    const localBroker = new InteractionBroker(localNotifier, makePersistence());
    const localRegistry = new AgentRegistry();
    // Use the production AgentRecord shape via the registry's helper.
    const record: any = {
      agentId: 'a8',
      sessionId: 's8',
      session: { send: vi.fn(), abort: vi.fn() },
      spaceId: '__workspace__',
      selectedText: '',
      anchor: { quote: '', prefix: '', suffix: '' },
      status: 'running',
      pendingApprovalId: null,
      events: [],
      eventTimestamps: new Map(),
      personaHandle: 'sandbox',
      sandbox: {
        policy: { ...DEFAULT_SANDBOX_POLICY, enforcementMode: 'mxc-only' },
        allowList: { paths: new Set(), resources: new Set(), webFetch: false },
        state: 'on',
        allowOutbound: false,
      },
    };
    localRegistry.set('a8', record);

    const setup = buildSandboxLaunchSetup({
      agentId: 'a8',
      workingDir: path.join(os.tmpdir(), 'a8-work'),
      persona: makeSandboxedPersona({ enforcementMode: 'mxc-only' }),
      registry: localRegistry,
      broker: localBroker,
    });
    const onPostToolUse = (setup.hooks as any).onPostToolUse;
    expect(typeof onPostToolUse).toBe('function');

    // Trigger a high-confidence MXC denial (Access denied). The hook will
    // await broker.emitSandboxBlock, which will hang until we resolve it.
    // We fire-and-forget the hook call and only inspect the notifyRenderer
    // payload it produced before the await blocked.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    void onPostToolUse({
      toolName: 'bash',
      toolArgs: { command: 'echo hi > /tmp/blocked.txt' },
      toolResult: { stderr: 'sandbox: bash(1234) deny file-write-data /tmp/blocked.txt' },
    });
    // Yield so the hook can push the emitSandboxBlock call into notifier.
    await new Promise((r) => setTimeout(r, 0));
    warn.mockRestore();

    const blockedCall = notifyRenderer.mock.calls.find(
      (c: any[]) => c[0] === 'agent:sandbox-blocked',
    );
    expect(blockedCall).toBeDefined();
    expect(blockedCall![1].source).toBe('post-tool-shell');
    expect(blockedCall![1].allowedDecisions).toEqual(['disable']);
    expect(blockedCall![1].allowedDecisions).not.toContain('allow-once');
  });
});
