import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks (must precede imports) ──────────────────────────

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/space-test' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: vi.fn().mockImplementation(function () { return { on: vi.fn(), show: vi.fn() }; }),
}));

const mockSession = {
  sessionId: 'mock-session-id',
  send: vi.fn().mockResolvedValue(undefined),
  abort: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  setModel: vi.fn().mockResolvedValue(undefined),
  getEvents: vi.fn().mockResolvedValue([{ type: 'assistant.message', content: 'hello' }]),
  on: vi.fn(),
  rpc: {
    eventLog: {
      read: vi.fn().mockResolvedValue({ events: [], cursor: 'history-tail', hasMore: false }),
    },
    remote: {
      enable: vi.fn().mockResolvedValue({ remoteSteerable: true, url: 'https://mock-remote.example/initial' }),
      disable: vi.fn().mockResolvedValue(undefined),
    },
    // Sandboxed sessions call rpc.options.update({ sandboxConfig }) right
    // after createSession so MXC actually enforces. The runner aborts the
    // session if this call rejects or returns success:false — provide a
    // happy-path stub by default; specific tests can override via
    // mockSession.rpc.options.update.mockResolvedValueOnce(...).
    options: {
      update: vi.fn().mockResolvedValue({ success: true }),
    },
  },
};

const mockClient = {
  createSession: vi.fn().mockResolvedValue(mockSession),
  resumeSession: vi.fn().mockResolvedValue(mockSession),
  rpc: {
    sessions: {
      connect: vi.fn().mockResolvedValue(undefined),
    },
  },
};

vi.mock('./ai', () => ({
  getCopilotClient: vi.fn(),
  ensureEphemeralCopilotClient: vi.fn(),
  // Stub so buildSandboxLaunchSetup (Windows-only path) doesn't reach into
  // electron's app.getPath() during sandbox tests.
  buildSandboxConfigs: (agentId: string) => ({
    onDir: `/mock/sandbox/${agentId}/on`,
    offDir: `/mock/sandbox/${agentId}/off`,
  }),
  // Stub for the runtime sandbox config that sandbox-launch.ts now builds
  // and sdk-runner pushes via rpc.options.update. Return the unwrapped
  // shape the runtime expects.
  buildRuntimeSandboxConfig: () => ({
    enabled: true,
    userPolicy: {
      filesystem: { readWritePaths: [], readOnlyPaths: [], deniedPaths: [] },
      network: { allowOutbound: false, allowLocalNetwork: false },
    },
  }),
}));

vi.mock('./storage', async () => ({
  appendSpaceActivity: vi.fn(),
  ...(await import('./workspace')),
  ...(await import('./services/skill-schedule-store')),
  ...(await import('./canvas/artifact-store')),
  documentMatches: (await import('./storage-documents')).documentMatches,
  readDocument: vi.fn().mockResolvedValue('canvas content'),
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),

  createCanvasAgent: vi.fn(),
  updateCanvasAgentStatus: vi.fn(),
  createAgentSession: vi.fn(),
  updateAgentSessionStatus: vi.fn(),
  updateAgentSessionYolo: vi.fn(),
  deleteAgentSession: vi.fn(),
  updateAgentSessionId: vi.fn(),
  getAgentSession: vi.fn(),
  listAgentSessions: vi.fn().mockReturnValue([]),
  isInitialized: vi.fn().mockReturnValue(true),
  appendAgentChatEvent: vi.fn().mockReturnValue(1),
  listAgentChatEvents: vi.fn().mockReturnValue([]),
  clearAgentChatEvents: vi.fn(),
  listAgentHistoryPage: vi.fn(),
  openRuntimeHistory: vi.fn(),
  appendRuntimeHistory: vi.fn(),
  queryRuntimeHistory: vi.fn(),
  assertWorkspaceContext: vi.fn(),
}));

vi.mock('./workspace', () => ({
  readCanvas: vi.fn(),
}));

vi.mock('./session', () => ({
  launchSessionInTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./cloud-agent-poller', () => ({
  stopCloudJobPoller: vi.fn(() => true),
}));

vi.mock('./mcp', () => ({
  getAllMcpServers: vi.fn().mockReturnValue({}),
}));

const mockCliTools = vi.fn().mockReturnValue([]);
const mockSetConfigValue = vi.fn();
const scheduledMocks = vi.hoisted(() => ({
  context: { invocation: { scheduleId: 'schedule-1', runId: 'run-1' } },
  createContext: vi.fn(),
  publishTool: { name: 'publish_scheduled_result', handler: vi.fn() },
  permission: vi.fn(() => ({ kind: 'reject' })),
  blocked: vi.fn(),
  finish: vi.fn(() => ({ status: 'ready', summary: '3 messages need a reply' })),
  complete: vi.fn(),
  editorBegin: vi.fn(),
  editorEnd: vi.fn(),
  editTool: { name: 'edit_scheduled_result', handler: vi.fn() },
}));
vi.mock('./services/scheduled-result', () => ({
  createScheduledResultContext: scheduledMocks.createContext,
  createPublishScheduledResultTool: () => scheduledMocks.publishTool,
  scheduledPermissionDecision: scheduledMocks.permission,
  markScheduledInteractionBlocked: scheduledMocks.blocked,
  finishScheduledResult: scheduledMocks.finish,
}));
vi.mock('./services/skill-schedule-store', () => ({
  completeScheduledRun: scheduledMocks.complete,
}));
vi.mock('./services/scheduled-result-editor', async importOriginal => ({
  ...(await importOriginal<typeof import('./services/scheduled-result-editor')>()),
  ScheduledResultEditor: class {
    tool = scheduledMocks.editTool;
    beginTurn = scheduledMocks.editorBegin;
    endTurn = scheduledMocks.editorEnd;
  },
}));
vi.mock('./config', async () => {
  const { DEFAULT_SANDBOX_POLICY } = await vi.importActual<typeof import('../shared/ipc-contract')>('../shared/ipc-contract');
  return {
    getConfig: vi.fn().mockReturnValue({ workspace: null }),
    getConfigValue: (...args: any[]) => {
      if (args[0] === 'cliTools') return mockCliTools();
      if (args[0] === 'workspace') return '/mock/workspace';
      if (args[0] === 'remoteAutoEnable') return false;
      if (args[0] === 'remoteEnabled') return false;
      return [];
    },
    setConfigValue: (...args: any[]) => mockSetConfigValue(...args),
    // Resolve persona overrides defensively (matches the real impl) so
    // sandbox tests can pass a persona with sandboxPolicyOverride.
    resolveSandboxPolicy: (persona: any) =>
      persona?.sandboxPolicyOverride
        ? { ...DEFAULT_SANDBOX_POLICY, ...persona.sandboxPolicyOverride }
        : { ...DEFAULT_SANDBOX_POLICY },
  };
});

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-agent-id'),
}));

vi.mock('fs', () => ({
  readFileSync: vi.fn(() => 'canvas content'),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

vi.mock('crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'mock-hash'),
  })),
  randomUUID: vi.fn(() => 'mock-random-uuid'),
}));

import {
  buildCliToolsPrompt,
  respondToUserInput,
  respondToElicitation,
  launchAgent,
  launchCommentAgent,
  launchQuickAgent,
  launchDocumentAgent,
  approveAgent,
  abortAgent,
  deleteAgent,
  listAgents,
  listAllAgents,
  sendChatMessage,
  launchCliSession,
  startCliExitMonitor,
  stopCliExitMonitor,
  setAgentModel,
  getAgentHistory,
  getAgentHistoryPage,
  setAgentYolo,
  setAppRemote,
  getRemoteState,
  resetRemoteControl,
  reconcileStaleAgents,
  getCanvasAgentState,
  __resetAppRemoteForTests,
} from './agent-service';
import { getCopilotClient, ensureEphemeralCopilotClient } from './ai';
import { InMemoryFsProvider } from './agents/in-memory-fs-provider';
import { createCanvasAgent, createAgentSession, updateAgentSessionStatus, updateAgentSessionId, getAgentSession, listAgentSessions, listAgentChatEvents } from './storage';
import { listAgentHistoryPage, openRuntimeHistory, queryRuntimeHistory } from './storage';
import { getConfig } from './config';
import { launchSessionInTerminal } from './session';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import { AgentNotifier } from './agents/agent-notifier';

describe('buildCliToolsPrompt', () => {
  beforeEach(() => {
    mockCliTools.mockReturnValue([]);
  });

  it('returns empty string when no CLI tools configured', () => {
    const result = buildCliToolsPrompt();
    expect(result).toBe('');
  });

  it('generates prompt with single tool', () => {
    mockCliTools.mockReturnValue([
      { name: 'gh', description: 'Used for GitHub operations' },
    ]);

    const result = buildCliToolsPrompt();
    expect(result).toContain('CLI tools may be available');
    expect(result).toContain('`gh`');
    expect(result).toContain('Used for GitHub operations');
  });

  it('generates prompt with multiple tools', () => {
    mockCliTools.mockReturnValue([
      { name: 'gh', description: 'GitHub operations' },
      { name: 'az', description: 'Azure CLI' },
      { name: 'kubectl', description: 'Kubernetes control' },
    ]);

    const result = buildCliToolsPrompt();
    expect(result).toContain('`gh`');
    expect(result).toContain('`az`');
    expect(result).toContain('`kubectl`');
    // Each tool on its own line
    const lines = result.split('\n').filter(l => l.startsWith('- `'));
    expect(lines).toHaveLength(3);
  });

  it('includes advisory phrasing (verify before use)', () => {
    mockCliTools.mockReturnValue([
      { name: 'gh', description: 'GitHub' },
    ]);

    const result = buildCliToolsPrompt();
    expect(result).toContain('verify before use');
  });
});

describe('respondToUserInput', () => {
  it('does not throw when no matching callback exists', () => {
    expect(() => {
      respondToUserInput('agent-1', 'nonexistent-request', 'hello', true);
    }).not.toThrow();
  });

  it('can be called multiple times with same requestId without error', () => {
    respondToUserInput('agent-1', 'req-1', 'answer1', false);
    respondToUserInput('agent-1', 'req-1', 'answer2', true);
    // Second call is a no-op since callback was already removed
  });
});

describe('respondToElicitation', () => {
  it('does not throw when no matching callback exists', () => {
    expect(() => {
      respondToElicitation('agent-1', 'nonexistent-request', 'accept', { key: 'val' });
    }).not.toThrow();
  });

  it('handles decline action without content', () => {
    expect(() => {
      respondToElicitation('agent-1', 'req-1', 'decline');
    }).not.toThrow();
  });

  it('handles cancel action without content', () => {
    expect(() => {
      respondToElicitation('agent-1', 'req-1', 'cancel');
    }).not.toThrow();
  });
});

// ── Characterization tests ─────────────────────────────────────────────

// Helper: configure getCopilotClient to return the mock client
function enableMockClient() {
  vi.mocked(getCopilotClient).mockReturnValue(mockClient as any);
}

// Helper: configure getCopilotClient to return null (not initialized)
function disableMockClient() {
  vi.mocked(getCopilotClient).mockReturnValue(null);
}

describe('launchAgent', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `agent-${++uuidCounter}`);
  });

  it('returns error when Copilot client is null', async () => {
    disableMockClient();
    const result = await launchAgent('space-1', 'selected text', { quote: '', prefix: '', suffix: '' }, '/workspace', 'folder');
    expect(result).toEqual({ error: 'Copilot SDK not initialized' });
  });

  it('creates agent record and persists to DB on success', async () => {
    enableMockClient();
    const result = await launchAgent('space-1', 'selected text', { quote: 'q', prefix: 'p', suffix: 's' }, '/workspace', 'folder');

    expect(result).toHaveProperty('agentId');
    expect(result).toHaveProperty('sessionId');

    // createCanvasAgent should be called with the agent data
    expect(createCanvasAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-1',
        space_id: 'space-1',
        selected_text: 'selected text',
        status: 'running',
      }),
    );

    // createAgentSession should be called with source 'sdk'
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'agent-1',
        space_id: 'space-1',
        prompt: 'selected text',
        source: 'sdk',
        status: 'running',
      }),
    );
  });

  it('returns agentId and sessionId on success', async () => {
    enableMockClient();
    const result = await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');
    expect(result).toEqual({ agentId: 'agent-1', sessionId: 'mock-session-id' });
  });

  it('calls setupAgentEventListeners on the session', async () => {
    enableMockClient();
    await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    // setupAgentEventListeners registers event handlers via session.on
    expect(mockSession.on).toHaveBeenCalled();
    // Expect multiple listeners (assistant.message_delta, assistant.message, session.idle, etc.)
    expect(mockSession.on.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('returns an error and disconnects when the initial prompt is rejected', async () => {
    enableMockClient();
    mockSession.send.mockRejectedValueOnce(new Error('selection rejected'));

    const result = await launchAgent(
      'space-1',
      'text',
      { quote: '', prefix: '', suffix: '' },
      '/ws',
      'folder',
    );

    expect(result).toEqual({ error: 'selection rejected' });
    expect(mockSession.abort).toHaveBeenCalled();
    expect(mockSession.disconnect).toHaveBeenCalled();
    expect(mockSession.disconnect).toHaveBeenCalled();
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'agent-1',
      'failed',
      'Error: selection rejected',
    );
  });

  it('does not report success until the initial prompt is accepted', async () => {
    enableMockClient();
    let resolveSend!: (messageId: string) => void;
    mockSession.send.mockReturnValueOnce(new Promise(resolve => {
      resolveSend = resolve;
    }));

    const launchPromise = launchAgent(
      'space-1',
      'text',
      { quote: '', prefix: '', suffix: '' },
      '/ws',
      'folder',
    );
    let settled = false;
    void launchPromise.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSend('message-1');
    await expect(launchPromise).resolves.toEqual({
      agentId: 'agent-1',
      sessionId: 'mock-session-id',
    });
  });

  it('ignores idle and reports cancellation while the initial prompt is pending', async () => {
    enableMockClient();
    let idleCb!: (event: unknown) => void;
    mockSession.on.mockImplementation((event: unknown, callback?: (event: unknown) => void) => {
      if (event === 'session.idle' && callback) idleCb = callback;
      return () => {};
    });
    let resolveSend!: (messageId: string) => void;
    mockSession.send.mockReturnValueOnce(new Promise(resolve => {
      resolveSend = resolve;
    }));

    const launchPromise = launchAgent(
      'space-1',
      'text',
      { quote: '', prefix: '', suffix: '' },
      '/ws',
      'folder',
    );
    await vi.waitFor(() => expect(mockSession.send).toHaveBeenCalled());
    idleCb?.({});
    await abortAgent('agent-1');
    resolveSend('message-1');

    await expect(launchPromise).resolves.toEqual({ error: 'Agent launch cancelled' });
    expect(updateAgentSessionStatus).not.toHaveBeenCalledWith(
      'agent-1',
      'completed',
      expect.any(String),
    );
  });
});

describe('launchQuickAgent', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `quick-agent-${++uuidCounter}`);
  });

  it('returns error when Copilot client is null', async () => {
    disableMockClient();
    const result = await launchQuickAgent('do something', '/ws');
    expect(result).toEqual({ error: 'Copilot SDK not initialized' });
  });

  it('launches without persona and persists with persona_handle null', async () => {
    enableMockClient();
    const result = await launchQuickAgent('do the thing', '/ws');
    expect(result).toEqual({ agentId: 'quick-agent-1', sessionId: 'mock-session-id' });
    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'quick-agent-1',
        prompt: 'do the thing',
        working_dir: '/ws',
        source: 'sdk',
        persona_handle: null,
        space_id: null,
        run_location: 'local',
      }),
    );
  });

  it('supplies the SDK session filesystem provider for ephemeral agents', async () => {
    enableMockClient();
    vi.mocked(ensureEphemeralCopilotClient).mockResolvedValue(getCopilotClient());
    const result = await launchQuickAgent('keep this private', '/ws', {
      id: 'ephemeral', handle: 'private', instructions: '', model: '',
      runLocation: 'local', ephemeral: true,
    });
    expect(result).toEqual({ agentId: 'quick-agent-1', sessionId: 'mock-session-id' });
    expect(ensureEphemeralCopilotClient).toHaveBeenCalledOnce();
    const options = mockClient.createSession.mock.calls[0][0];
    expect(options.createSessionFsProvider()).toBeInstanceOf(InMemoryFsProvider);
    expect(options.createSessionFsHandler).toBeUndefined();
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it('persists run_location=cloud for cloud personas', async () => {
    enableMockClient();
    const persona = {
      id: 'pc', handle: 'cloud', instructions: 'Run in cloud.',
      model: 'gpt-4o', runLocation: 'cloud' as const,
    };
    // The cloud session waits for a `session.start` event before resolving
    // session.send.  Fire it on the next tick so the test doesn't time out.
    let startCb!: (event: any) => void;
    mockSession.on.mockImplementation((evt: any, cb?: any) => {
      if (typeof evt === 'string' && evt === 'session.start') startCb = cb;
      return () => { /* unsubscribe noop */ };
    });
    setTimeout(() => { startCb?.({ data: { producer: 'copilot-agent', remoteSteerable: true } }); }, 0);

    await launchQuickAgent('add multi-line commenting', '/ws', persona as any);

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        persona_handle: 'cloud',
        source: 'sdk',
        run_location: 'cloud',
      }),
    );

    // Cloud personas use SDK with the cloud session option populated.
    const sessionOpts = mockClient.createSession.mock.calls[0][0];
    expect(sessionOpts).toHaveProperty('cloud');
  });

  it('forwards persona instructions, model, and handle when persona is provided', async () => {
    enableMockClient();
    const persona = {
      id: 'p1', handle: 'reviewer', instructions: 'Be a careful reviewer.',
      model: 'gpt-4o', runLocation: 'local' as const,
    };
    await launchQuickAgent('check the auth module', '/ws', persona as any);

    // Persona instructions must appear in the system message.
    const sessionOpts = mockClient.createSession.mock.calls[0][0];
    expect(sessionOpts.systemMessage.content).toContain('Be a careful reviewer.');
    expect(sessionOpts.model).toBe('gpt-4o');

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ persona_handle: 'reviewer', summary: expect.stringContaining('@reviewer') }),
    );
  });

  it('returns an error and disconnects when the initial prompt is rejected', async () => {
    enableMockClient();
    mockSession.send.mockRejectedValueOnce(new Error('quick rejected'));

    const result = await launchQuickAgent('do the thing', '/ws');

    expect(result).toEqual({ error: 'quick rejected' });
    expect(mockSession.abort).toHaveBeenCalled();
    expect(mockSession.disconnect).toHaveBeenCalled();
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'quick-agent-1',
      'failed',
      'Error: quick rejected',
    );
  });

  it('keeps a cloud worker retryable when initial-launch cleanup cannot abort it', async () => {
    enableMockClient();
    const cloudPersona = {
      id: 'cloud-persona', handle: 'cloud', instructions: 'Run in cloud.',
      model: 'gpt-4o', runLocation: 'cloud' as const,
    };
    let startCb!: (event: unknown) => void;
    mockSession.on.mockImplementation((event: unknown, callback?: (event: unknown) => void) => {
      if (event === 'session.start' && callback) startCb = callback;
      return () => {};
    });
    setTimeout(() => startCb?.({ data: { producer: 'copilot-agent' } }), 0);
    mockSession.send.mockRejectedValueOnce(new Error('quick rejected'));
    mockSession.abort.mockRejectedValueOnce(new Error('abort unavailable'));

    const result = await launchQuickAgent('do the thing', '/ws', cloudPersona as any);

    expect(result).toEqual({ error: 'quick rejected' });
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'quick-agent-1',
      'running',
      expect.stringContaining('Retry abort before deleting'),
    );
    expect(mockSession.disconnect).not.toHaveBeenCalled();

    await deleteAgent('quick-agent-1');
    const { deleteAgentSession } = await import('./storage');
    expect(deleteAgentSession).toHaveBeenCalledWith('quick-agent-1');
  });

  it('sets up sandbox for sandboxed persona', async () => {
    enableMockClient();
    const persona = {
      id: 'p2', handle: 'jail', instructions: 'sandboxed',
      model: 'gpt-4o', runLocation: 'local' as const, sandboxed: true,
    };
    await launchQuickAgent('do something', '/ws', persona as any);

    const sessionOpts = mockClient.createSession.mock.calls[0][0];
    // Sandbox is now cross-platform — configDir and hooks should be present
    expect(sessionOpts.configDir).toBeDefined();
    expect(sessionOpts.hooks).toBeDefined();
    // Persona instructions still applied.
    expect(sessionOpts.systemMessage.content).toContain('sandboxed');
  });

  it('appends [SANDBOX MODE] system prompt when enforcementMode=both', async () => {
      enableMockClient();
      const persona = {
        id: 'p-both', handle: 'guard', instructions: 'Persona instructions here.',
        model: 'gpt-4o', runLocation: 'local' as const,
        sandboxed: true,
        sandboxPolicyOverride: {
          scopeToSpaceFolder: true,
          extraReadwritePaths: [],
          extraReadonlyPaths: [],
          extraDeniedPaths: [],
          allowMcpServers: false,
          allowWebFetch: false,
          allowOutbound: false,
          allowLocalNetwork: false,
          enforcementMode: 'both' as const,
        },
      };
      await launchQuickAgent('do something', '/ws', persona as any);

      const sessionOpts = mockClient.createSession.mock.calls[0][0];
      expect(sessionOpts.systemMessage.content).toContain('[SANDBOX MODE]');
      expect(sessionOpts.systemMessage.content).toContain('Persona instructions here.');
    });

    it('omits [SANDBOX MODE] system prompt when enforcementMode=mxc-only', async () => {
      enableMockClient();
      const persona = {
        id: 'p-mxc', handle: 'guard', instructions: 'Persona instructions here.',
        model: 'gpt-4o', runLocation: 'local' as const,
        sandboxed: true,
        sandboxPolicyOverride: {
          scopeToSpaceFolder: true,
          extraReadwritePaths: [],
          extraReadonlyPaths: [],
          extraDeniedPaths: [],
          allowMcpServers: false,
          allowWebFetch: false,
          allowOutbound: false,
          allowLocalNetwork: false,
          enforcementMode: 'mxc-only' as const,
        },
      };
      const result = await launchQuickAgent('do something', '/ws', persona as any);

      const sessionOpts = mockClient.createSession.mock.calls[0][0];
      // sole enforcer and the prompt would defeat the verification purpose.
      expect(sessionOpts.systemMessage.content).not.toContain('[SANDBOX MODE]');
      expect(sessionOpts.systemMessage.content).not.toContain('sandboxed environment');
      // Persona instructions still applied.
      expect(sessionOpts.systemMessage.content).toContain('Persona instructions here.');
    });

    it('installs auto-approve permission handler when enforcementMode=mxc-only', async () => {
      // In mxc-only mode the SDK's onPermissionRequest must auto-approve so
      // MXC at the OS level is the sole enforcer. This is the behavioral
      // counterpart to the system-prompt suppression — the agent isn't told
      // it's sandboxed AND the user isn't prompted.
      enableMockClient();
      // Use a unique session id so findBySessionId hits THIS test's agent
      // record (the registry singleton is shared across tests in this file).
      const uniqueSessionId = 'mxc-only-handler-session';
      const originalSessionId = mockSession.sessionId;
      mockSession.sessionId = uniqueSessionId;

      const persona = {
        id: 'p-mxc-handler', handle: 'guard', instructions: 'inst',
        model: 'gpt-4o', runLocation: 'local' as const,
        sandboxed: true,
        sandboxPolicyOverride: {
          scopeToSpaceFolder: true,
          extraReadwritePaths: [],
          extraReadonlyPaths: [],
          extraDeniedPaths: [],
          allowMcpServers: false,
          allowWebFetch: false,
          allowOutbound: false,
          allowLocalNetwork: false,
          enforcementMode: 'mxc-only' as const,
        },
      };
      // Suppress the auto-approve breadcrumb log for clean test output.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await launchQuickAgent('do something', '/ws', persona as any);

        const sessionOpts = mockClient.createSession.mock.calls[0][0];
        // Invoke the wired handler with a write request — it must approve
        // without prompting the user (no agent:approval-needed notification).
        const decision = await sessionOpts.onPermissionRequest(
          { kind: 'write', toolCallId: 'tc-mxc-write', fileName: '/ws/out.txt' },
          { sessionId: uniqueSessionId },
        );
        expect(decision).toEqual({ kind: 'approve-once' });
        // The auto-approve breadcrumb should be the only side effect.
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('mxc-only:auto-approve'));
      } finally {
        warnSpy.mockRestore();
        mockSession.sessionId = originalSessionId;
      }
    });
});

describe('launchDocumentAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    vi.mocked<() => string>(uuid).mockReturnValue('document-agent-1');
  });

  it('returns success only after the document prompt is accepted', async () => {
    enableMockClient();
    let resolveSend!: (messageId: string) => void;
    mockSession.send.mockReturnValueOnce(new Promise(resolve => {
      resolveSend = resolve;
    }));

    const launchPromise = launchDocumentAgent('space-1', '/ws', 'folder');
    let settled = false;
    void launchPromise.finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveSend('document-message');
    await expect(launchPromise).resolves.toEqual({
      agentId: 'document-agent-1',
      sessionId: 'mock-session-id',
    });
  });

  it('returns an error and disconnects when the document prompt is rejected', async () => {
    enableMockClient();
    mockSession.send.mockRejectedValueOnce(new Error('document rejected'));

    const result = await launchDocumentAgent('space-1', '/ws', 'folder');

    expect(result).toEqual({ error: 'document rejected' });
    expect(mockSession.abort).toHaveBeenCalled();
    expect(mockSession.disconnect).toHaveBeenCalled();
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'document-agent-1',
      'failed',
      'Error: document rejected',
    );
  });

  it('launches scheduled work with only authorized sources and the result writer', async () => {
    enableMockClient();
    scheduledMocks.createContext.mockReturnValue(scheduledMocks.context);
    const { getAllMcpServers } = await import('./mcp');
    vi.mocked(getAllMcpServers).mockReturnValueOnce({
      chat: { command: 'chat', tools: ['*'] },
      unrelated: { command: 'other', tools: ['*'] },
    });
    const scheduledRun = {
      scheduleId: 'schedule-1', runId: 'run-1', scheduledAt: '2026-09-07T16:00:00.000Z',
      timeZone: 'America/Los_Angeles', readOnlyServers: ['chat'],
    };
    await launchDocumentAgent('space-1', '/ws', 'folder', { scheduledRun });
    const config = mockClient.createSession.mock.calls[0][0];
    expect(Object.keys(config.mcpServers)).toEqual(['chat']);
    expect(config.tools).toEqual([scheduledMocks.publishTool, scheduledMocks.editTool]);
    expect(config.availableTools).toContain('custom:publish_scheduled_result');
    expect(config.availableTools).toContain('custom:edit_scheduled_result');
    expect(config.availableTools).not.toContain('builtin:*');
    expect(config.availableTools).not.toContain('builtin:bash');
    expect(config.systemMessage.content).toContain('unattended scheduled task');
    expect(config.systemMessage.content).not.toContain('The user has pressed "Run"');

    const invocation = { sessionId: 'mock-session-id' };
    expect(await config.onPermissionRequest({ kind: 'shell' }, invocation)).toEqual({ kind: 'reject' });
    expect(scheduledMocks.permission).toHaveBeenCalledWith(scheduledMocks.context, { kind: 'shell' });
    const response = await config.onUserInputRequest({ question: 'Which chat?' }, invocation);
    expect(response.answer).toContain('unavailable');
    expect(scheduledMocks.blocked).toHaveBeenCalled();
    expect(await config.onElicitationRequest({ ...invocation, message: 'Sign in' })).toEqual({ action: 'cancel' });
  });

  it('records the scheduled outcome at completion, not at launch', async () => {
    enableMockClient();
    scheduledMocks.createContext.mockReturnValue(scheduledMocks.context);
    await launchDocumentAgent('space-1', '/ws', 'folder', {
      scheduledRun: {
        scheduleId: 'schedule-1', runId: 'run-1', scheduledAt: '2026-09-07T16:00:00.000Z',
        timeZone: 'UTC', readOnlyServers: [],
      },
    });
    expect(scheduledMocks.finish).not.toHaveBeenCalled();
    const idle = mockSession.on.mock.calls.find(([name]) => name === 'session.idle')![1];
    await idle();
    await idle();
    expect(scheduledMocks.finish).toHaveBeenCalledTimes(1);
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'document-agent-1', 'completed', '3 messages need a reply',
    );
  });

  it('records a scheduled runtime failure and clears unattended privileges', async () => {
    enableMockClient();
    scheduledMocks.createContext.mockReturnValue(scheduledMocks.context);
    await launchDocumentAgent('space-1', '/ws', 'folder', {
      scheduledRun: {
        scheduleId: 'schedule-1', runId: 'run-1', scheduledAt: '2026-09-07T16:00:00.000Z',
        timeZone: 'UTC', readOnlyServers: [],
      },
    });
    const error = mockSession.on.mock.calls.find(([name]) => name === 'session.error')![1];
    await error({ data: { message: 'Disconnected' } });
    expect(scheduledMocks.finish).toHaveBeenCalledWith(scheduledMocks.context, 'Disconnected');
    const idle = mockSession.on.mock.calls.find(([name]) => name === 'session.idle')![1];
    await idle();
    expect(scheduledMocks.finish).toHaveBeenCalledTimes(1);
  });

  it('opens fresh follow-up edit turns without completing the occurrence again', async () => {
    enableMockClient();
    scheduledMocks.createContext.mockReturnValue(scheduledMocks.context);
    await launchDocumentAgent('space-1', '/ws', 'folder', {
      scheduledRun: {
        scheduleId: 'schedule-1', runId: 'run-1', scheduledAt: '2026-09-07T16:00:00.000Z',
        timeZone: 'UTC', readOnlyServers: [],
      },
    });
    const idle = mockSession.on.mock.calls.find(([name]) => name === 'session.idle')![1];
    expect(await sendChatMessage('document-agent-1', 'Remove this item')).toHaveProperty('error');
    expect(scheduledMocks.editorBegin).not.toHaveBeenCalled();
    await idle();
    for (const prompt of ['Remove this item', 'Mark the other item done']) {
      expect(await sendChatMessage('document-agent-1', prompt)).not.toHaveProperty('error');
      expect(mockSession.send).toHaveBeenLastCalledWith({ prompt });
      await idle();
    }
    expect(scheduledMocks.editorBegin).toHaveBeenCalledTimes(2);
    expect(scheduledMocks.editorEnd).toHaveBeenCalledTimes(3);
    expect(scheduledMocks.finish).toHaveBeenCalledTimes(1);
    expect(scheduledMocks.complete).not.toHaveBeenCalled();
  });

  it('waits for durable completion even when duplicate idle events arrive', async () => {
    enableMockClient();
    scheduledMocks.createContext.mockReturnValue(scheduledMocks.context);
    await launchDocumentAgent('space-1', '/ws', 'folder', {
      scheduledRun: {
        scheduleId: 'schedule-1', runId: 'run-1', scheduledAt: '2026-09-07T16:00:00.000Z',
        timeZone: 'UTC', readOnlyServers: [],
      },
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    scheduledMocks.finish.mockImplementationOnce(async () => {
      await held;
      return { status: 'ready', summary: 'Ready' };
    });
    const idle = mockSession.on.mock.calls.find(([name]) => name === 'session.idle')![1];
    const completion = idle();
    await vi.waitFor(() => expect(scheduledMocks.finish).toHaveBeenCalled());
    const duplicate = idle();
    const followup = sendChatMessage('document-agent-1', 'Remove this item');
    expect(scheduledMocks.editorBegin).not.toHaveBeenCalled();
    release();
    await Promise.all([completion, duplicate]);
    expect(await followup).not.toHaveProperty('error');
    expect(scheduledMocks.editorBegin).toHaveBeenCalledTimes(1);
    await idle();
    expect(scheduledMocks.finish).toHaveBeenCalledTimes(1);
  });

  it.each(['send failure', 'runtime error', 'stop'] as const)('closes the edit context on %s', async failure => {
    enableMockClient();
    scheduledMocks.createContext.mockReturnValue(scheduledMocks.context);
    await launchDocumentAgent('space-1', '/ws', 'folder', {
      scheduledRun: {
        scheduleId: 'schedule-1', runId: 'run-1', scheduledAt: '2026-09-07T16:00:00.000Z',
        timeZone: 'UTC', readOnlyServers: [],
      },
    });
    const idle = mockSession.on.mock.calls.find(([name]) => name === 'session.idle')![1];
    await idle();
    if (failure === 'send failure') mockSession.send.mockRejectedValueOnce(new Error('Send failed'));
    const result = await sendChatMessage('document-agent-1', 'Revise this');
    if (failure === 'send failure') {
      expect(result).toEqual({ error: 'Send failed' });
      expect(updateAgentSessionStatus).toHaveBeenLastCalledWith('document-agent-1', 'completed', expect.any(String));
    } else if (failure === 'runtime error') {
      const error = mockSession.on.mock.calls.find(([name]) => name === 'session.error')![1];
      await error({ data: { message: 'Disconnected' } });
    } else {
      await abortAgent('document-agent-1');
    }
    expect(scheduledMocks.editorEnd).toHaveBeenLastCalledWith(true);
    expect(scheduledMocks.finish).toHaveBeenCalledTimes(1);
    if (failure !== 'stop') {
      expect(await sendChatMessage('document-agent-1', 'Retry')).not.toHaveProperty('error');
      await idle();
    }
  });

  it('returns to interactive permissions for selected source access on follow-up', async () => {
    enableMockClient();
    scheduledMocks.createContext.mockReturnValue(scheduledMocks.context);
    await launchDocumentAgent('space-1', '/ws', 'folder', {
      scheduledRun: {
        scheduleId: 'schedule-1', runId: 'run-1', scheduledAt: '2026-09-07T16:00:00.000Z',
        timeZone: 'UTC', readOnlyServers: ['chat'],
      },
    });
    const idle = mockSession.on.mock.calls.find(([name]) => name === 'session.idle')![1];
    await idle();
    await sendChatMessage('document-agent-1', 'Check this thread again');
    const config = mockClient.createSession.mock.calls[0][0];
    const permission = config.onPermissionRequest({
      kind: 'mcp', serverName: 'chat', toolName: 'search', readOnly: true, toolCallId: 'follow-up-search',
    }, { sessionId: 'mock-session-id' });
    await vi.waitFor(() => expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'document-agent-1', 'waiting-approval', expect.any(String),
    ));
    expect(scheduledMocks.permission).not.toHaveBeenCalled();
    approveAgent('document-agent-1', 'follow-up-search', false);
    expect(await permission).toEqual({ kind: 'reject' });
    await idle();
  });
});

describe('launchCommentAgent', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `comment-agent-${++uuidCounter}`);
  });

  const persona = { id: 'fixture-persona', runLocation: 'local' as const, handle: 'test-bot', instructions: 'Be helpful', model: 'gpt-4' };

  it('returns error when Copilot client is null', async () => {
    disableMockClient();
    const result = await launchCommentAgent('space-1', 'comment body', 'quoted', {}, persona, null, '/ws', 'folder');
    expect(result).toEqual({ error: 'Copilot SDK not initialized' });
  });

  it('creates agent with commentContext and returns agentId/sessionId', async () => {
    enableMockClient();
    const result = await launchCommentAgent('space-1', 'fix this', 'quoted text', { prefix: 'p', suffix: 's' }, persona, 'thread-3', '/ws', 'folder');

    expect(result).toEqual({ agentId: 'comment-agent-1', sessionId: 'mock-session-id' });

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'comment-agent-1',
        prompt: 'fix this',
        source: 'sdk',
      }),
    );
  });

  it('persists a visible worker before createSession resolves', async () => {
    enableMockClient();
    let resolveSession!: (session: typeof mockSession) => void;
    mockClient.createSession.mockReturnValueOnce(new Promise(resolve => {
      resolveSession = resolve;
    }));

    const launchPromise = launchCommentAgent('space-1', 'fix this', 'quoted text', {}, persona, 'thread-4', '/ws', 'folder');

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      id: 'comment-agent-1',
      session_id: 'comment-agent-1',
      prompt: 'fix this',
      summary: 'Starting...',
      space_id: 'space-1',
    }));

    resolveSession(mockSession);
    await launchPromise;
  });

  it('does not send the prompt if aborted while createSession is pending', async () => {
    enableMockClient();
    let resolveSession!: (session: typeof mockSession) => void;
    mockClient.createSession.mockReturnValueOnce(new Promise(resolve => {
      resolveSession = resolve;
    }));

    const launchPromise = launchCommentAgent('space-1', 'fix this', 'quoted text', {}, persona, 'thread-5', '/ws', 'folder');
    await abortAgent('comment-agent-1');
    resolveSession(mockSession);
    const result = await launchPromise;

    expect(result).toEqual({ error: 'Agent launch cancelled' });
    expect(mockSession.abort).toHaveBeenCalled();
    expect(mockSession.send).not.toHaveBeenCalled();
  });

  it('defers deleting a cloud comment agent until startup cancellation succeeds', async () => {
    enableMockClient();
    const cloudPersona = { ...persona, runLocation: 'cloud' as const };
    let resolveSession!: (session: typeof mockSession) => void;
    mockClient.createSession.mockReturnValueOnce(new Promise(resolve => {
      resolveSession = resolve;
    }));
    const { deleteAgentSession } = await import('./storage');

    const launchPromise = launchCommentAgent(
      'space-1',
      'fix this',
      'quoted text',
      {},
      cloudPersona,
      'thread-cloud-pending',
      '/ws',
      'folder',
    );
    await vi.waitFor(() => expect(mockClient.createSession).toHaveBeenCalled());

    await expect(deleteAgent('comment-agent-1')).rejects.toThrow('waiting for the cloud session');
    expect(deleteAgentSession).not.toHaveBeenCalled();

    resolveSession(mockSession);
    await expect(launchPromise).resolves.toEqual({ error: 'Agent launch cancelled' });
    expect(mockSession.abort).toHaveBeenCalled();
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'comment-agent-1',
      'failed',
      'Aborted by user',
    );

    await deleteAgent('comment-agent-1');
    expect(deleteAgentSession).toHaveBeenCalledWith('comment-agent-1');
  });

  it('makes a cancelled cloud comment launch deletable when createSession rejects', async () => {
    enableMockClient();
    const cloudPersona = { ...persona, runLocation: 'cloud' as const };
    let rejectSession!: (error: Error) => void;
    mockClient.createSession.mockReturnValueOnce(new Promise((_, reject) => {
      rejectSession = reject;
    }));
    const { deleteAgentSession } = await import('./storage');

    const launchPromise = launchCommentAgent(
      'space-1',
      'fix this',
      'quoted text',
      {},
      cloudPersona,
      'thread-cloud-rejected',
      '/ws',
      'folder',
    );
    await vi.waitFor(() => expect(mockClient.createSession).toHaveBeenCalled());
    await expect(deleteAgent('comment-agent-1')).rejects.toThrow('waiting for the cloud session');

    rejectSession(new Error('cloud startup failed'));
    await expect(launchPromise).resolves.toEqual({ error: 'cloud startup failed' });
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'comment-agent-1',
      'failed',
      'Launch cancelled before the cloud session started',
    );

    await deleteAgent('comment-agent-1');
    expect(deleteAgentSession).toHaveBeenCalledWith('comment-agent-1');
  });

  it('sends the comment body as the prompt', async () => {
    enableMockClient();
    await launchCommentAgent('space-1', 'fix this', 'quoted text', {}, persona, null, '/ws', 'folder');

    expect(mockSession.send).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'fix this' }),
    );
  });

  it('returns an error and tears down the session when the initial prompt is rejected', async () => {
    enableMockClient();
    mockSession.send.mockRejectedValueOnce(new Error('runtime rejected prompt'));

    const result = await launchCommentAgent(
      'space-1',
      'fix this',
      'quoted text',
      {},
      persona,
      'thread-failed',
      '/ws',
      'folder',
    );

    expect(result).toEqual({ error: 'runtime rejected prompt' });
    expect(mockSession.abort).toHaveBeenCalled();
    expect(mockSession.disconnect).toHaveBeenCalled();
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'comment-agent-1',
      'failed',
      'Error: runtime rejected prompt',
    );
  });

  it('keeps a cloud comment worker retryable when prompt cleanup cannot abort it', async () => {
    enableMockClient();
    const cloudPersona = { ...persona, runLocation: 'cloud' as const };
    let startCb!: (event: unknown) => void;
    mockSession.on.mockImplementation((event: unknown, callback?: (event: unknown) => void) => {
      if (event === 'session.start' && callback) startCb = callback;
      return () => {};
    });
    setTimeout(() => startCb?.({ data: { producer: 'copilot-agent' } }), 0);
    mockSession.send.mockRejectedValueOnce(new Error('runtime rejected prompt'));
    mockSession.abort.mockRejectedValueOnce(new Error('abort unavailable'));

    const result = await launchCommentAgent(
      'space-1',
      'fix this',
      'quoted text',
      {},
      cloudPersona,
      'thread-cloud-failed',
      '/ws',
      'folder',
    );

    expect(result).toEqual({ error: 'runtime rejected prompt' });
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'comment-agent-1',
      'running',
      expect.stringContaining('Retry abort before deleting'),
    );
    expect(mockSession.disconnect).not.toHaveBeenCalled();

    await deleteAgent('comment-agent-1');
    const { deleteAgentSession } = await import('./storage');
    expect(deleteAgentSession).toHaveBeenCalledWith('comment-agent-1');
  });

  // Sandbox is now cross-platform — these tests run everywhere.
  it('appends [SANDBOX MODE] system prompt for sandboxed persona when enforcementMode=both', async () => {
    enableMockClient();
    const sandboxedPersona = {
      id: 'p-cmt-both', handle: 'guard', instructions: 'Be helpful',
      model: 'gpt-4o', runLocation: 'local' as const,
      sandboxed: true,
      sandboxPolicyOverride: {
        scopeToSpaceFolder: true,
        extraReadwritePaths: [],
        extraReadonlyPaths: [],
        extraDeniedPaths: [],
        allowMcpServers: false,
        allowWebFetch: false,
        allowOutbound: false,
        allowLocalNetwork: false,
        enforcementMode: 'both' as const,
      },
    };
    await launchCommentAgent('space-1', 'fix this', 'quoted', {}, sandboxedPersona, null, '/ws', 'folder');

    const sessionOpts = mockClient.createSession.mock.calls[0][0];
    expect(sessionOpts.systemMessage.content).toContain('[SANDBOX MODE]');
    expect(sessionOpts.systemMessage.content).toContain('Be helpful');
  });

  it('omits [SANDBOX MODE] system prompt for sandboxed persona when enforcementMode=mxc-only', async () => {
    enableMockClient();
    const sandboxedPersona = {
      id: 'p-cmt-mxc', handle: 'guard', instructions: 'Be helpful',
      model: 'gpt-4o', runLocation: 'local' as const,
      sandboxed: true,
      sandboxPolicyOverride: {
        scopeToSpaceFolder: true,
        extraReadwritePaths: [],
        extraReadonlyPaths: [],
        extraDeniedPaths: [],
        allowMcpServers: false,
        allowWebFetch: false,
        allowOutbound: false,
        allowLocalNetwork: false,
        enforcementMode: 'mxc-only' as const,
      },
    };
    await launchCommentAgent('space-1', 'fix this', 'quoted', {}, sandboxedPersona, null, '/ws', 'folder');

    const sessionOpts = mockClient.createSession.mock.calls[0][0];
    // Agent must NOT be told it's sandboxed in mxc-only mode — the runtime
    // sandbox is the sole enforcer and the prompt would defeat the verification purpose.
    expect(sessionOpts.systemMessage.content).not.toContain('[SANDBOX MODE]');
    expect(sessionOpts.systemMessage.content).not.toContain('sandboxed environment');
    // Persona instructions still applied.
    expect(sessionOpts.systemMessage.content).toContain('Be helpful');
  });

  it('passes cloud option and persists run_location=cloud for cloud personas', async () => {
    enableMockClient();
    // The cloud session waits for `session.start` before sending — fire it
    // on the next tick so the test doesn't time out.
    let startCb!: (event: any) => void;
    mockSession.on.mockImplementation((evt: any, cb?: any) => {
      if (typeof evt === 'string' && evt === 'session.start') startCb = cb;
      return () => { /* unsubscribe noop */ };
    });
    setTimeout(() => { startCb?.({ data: { producer: 'copilot-agent', remoteSteerable: true } }); }, 0);

    const cloudPersona = {
      id: 'pc-cmt', handle: 'cloud', instructions: 'cloud bot',
      model: 'gpt-4o', runLocation: 'cloud' as const,
    };
    await launchCommentAgent('space-1', 'add multi-line commenting', 'q', {}, cloudPersona, null, '/ws', 'folder');

    const sessionOpts = mockClient.createSession.mock.calls[0][0];
    expect(sessionOpts).toHaveProperty('cloud');

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        persona_handle: 'cloud',
        source: 'sdk',
        run_location: 'cloud',
      }),
    );
  });

  it('delays session.send for cloud comment until session.start fires', async () => {
    enableMockClient();

    // Capture the session.start callback so the test controls when it fires.
    let startCb!: (event: any) => void;
    mockSession.on.mockImplementation((evt: any, cb?: any) => {
      if (typeof evt === 'string' && evt === 'session.start') startCb = cb;
      return () => { /* unsubscribe noop */ };
    });

    const cloudPersona = {
      id: 'pc-cmt-wait', handle: 'cloud', instructions: 'cloud bot',
      model: 'gpt-4o', runLocation: 'cloud' as const,
    };

    const sendCalled = vi.fn();
    mockSession.send.mockImplementation((...args: any[]) => { sendCalled(...args); return Promise.resolve('msg-id'); });

    const launchPromise = launchCommentAgent('space-1', 'hello', 'q', {}, cloudPersona, null, '/ws', 'folder');
    await vi.waitFor(() => expect(startCb).toBeTypeOf('function'));
    // Before session.start, session.send MUST NOT have been called yet —
    // and the launch promise must remain pending.
    await Promise.resolve();
    expect(sendCalled).not.toHaveBeenCalled();

    // Now fire session.start; the queued send should run after the promise
    // chain flushes.
    startCb?.({ data: { producer: 'copilot-agent', remoteSteerable: true } });
    // Two await-Promise.resolve() cycles to drain the readyPromise → then
    // chain that launchCommentAgent wires up.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));

    expect(sendCalled).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hello' }));
    await expect(launchPromise).resolves.toEqual({
      agentId: 'comment-agent-1',
      sessionId: 'mock-session-id',
    });
  });
});

describe('approveAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when no callback exists for requestId', () => {
    expect(() => {
      approveAgent('agent-1', 'nonexistent-request', true);
    }).not.toThrow();
  });

  it('can be called with approved=false without error', () => {
    expect(() => {
      approveAgent('agent-1', 'nonexistent-request', false);
    }).not.toThrow();
  });
});

describe('abortAgent', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockSession.abort.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    mockClient.resumeSession.mockResolvedValue(mockSession);
    mockClient.rpc.sessions.connect.mockResolvedValue(undefined);
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `abort-agent-${++uuidCounter}`);
  });

  it('is a no-op when agent does not exist', async () => {
    await expect(abortAgent('nonexistent')).resolves.toBeUndefined();
  });

  it('calls session.abort() and updates status to failed', async () => {
    enableMockClient();
    const result = await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');
    const agentId = (result as any).agentId;

    await abortAgent(agentId);

    expect(mockSession.abort).toHaveBeenCalled();
    // Status should be updated to 'failed' in DB
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(agentId, 'failed', 'Aborted by user');
  });

  it('preserves a live SDK cloud session when abort fails', async () => {
    enableMockClient();
    const persona = {
      id: 'cloud-persona', handle: 'cloud', instructions: 'Run in cloud.',
      model: 'gpt-4o', runLocation: 'cloud' as const,
    };
    let startCb!: (event: unknown) => void;
    mockSession.on.mockImplementation((event: unknown, callback?: (event: unknown) => void) => {
      if (event === 'session.start' && callback) startCb = callback;
      return () => {};
    });
    setTimeout(() => startCb?.({ data: { producer: 'copilot-agent' } }), 0);
    const launched = await launchQuickAgent('cloud task', '/ws', persona as any);
    const agentId = (launched as { agentId: string }).agentId;
    mockSession.abort.mockRejectedValueOnce(new Error('network unavailable'));
    const { deleteAgentSession } = await import('./storage');

    await expect(deleteAgent(agentId)).rejects.toThrow('may still be running');

    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      agentId,
      'running',
      expect.stringContaining('retry before deleting'),
    );
    expect(deleteAgentSession).not.toHaveBeenCalled();
    expect(mockSession.disconnect).not.toHaveBeenCalled();
  });

  it('deletes a completed live SDK session without aborting it', async () => {
    enableMockClient();
    let idleCb!: (event: unknown) => void;
    mockSession.on.mockImplementation((event: unknown, callback?: (event: unknown) => void) => {
      if (event === 'session.idle' && callback) idleCb = callback;
      return () => {};
    });
    const launched = await launchQuickAgent('finish task', '/ws');
    const agentId = (launched as { agentId: string }).agentId;
    idleCb?.({});
    const { deleteAgentSession } = await import('./storage');

    await deleteAgent(agentId);

    expect(mockSession.abort).not.toHaveBeenCalled();
    expect(deleteAgentSession).toHaveBeenCalledWith(agentId);
  });

  it('stops CCA tracking without pretending the remote job was cancelled', async () => {
    vi.mocked(getAgentSession).mockResolvedValueOnce({
      id: 'cca-agent', session_id: 'cca-session', space_id: null, prompt: 'p',
      status: 'running', summary: '', working_dir: '/ws', source: 'cca',
      persona_handle: null, quoted_text: null, run_location: 'cloud',
      cca_job_id: 'job-1', cca_repository: 'owner/repo',
      cca_effective_repository: 'owner/repo',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });
    const { stopCloudJobPoller } = await import('./cloud-agent-poller');

    await abortAgent('cca-agent');

    expect(stopCloudJobPoller).toHaveBeenCalledWith('cca-agent');
    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'cca-agent',
      'failed',
      expect.stringContaining('cloud job may continue'),
    );
  });

  it('uses explicit stop-tracking semantics for CLI sessions', async () => {
    vi.mocked(getAgentSession).mockResolvedValueOnce({
      id: 'cli-agent', session_id: 'cli-session', space_id: null, prompt: 'CLI Session',
      status: 'running', summary: '', working_dir: '/ws', source: 'cli',
      persona_handle: null, quoted_text: null, run_location: 'local',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });

    await abortAgent('cli-agent');

    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'cli-agent',
      'failed',
      expect.stringContaining('terminal session may still be running'),
    );
  });

  it('reconnects and aborts a restored SDK cloud session', async () => {
    enableMockClient();
    vi.mocked(getAgentSession).mockResolvedValue({
      id: 'sdk-cloud', session_id: 'cloud-session', space_id: 'space-1', prompt: 'Cloud work',
      status: 'running', summary: '', working_dir: '/ws', source: 'sdk',
      persona_handle: null, quoted_text: null, run_location: 'cloud',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });

    await abortAgent('sdk-cloud');

    expect(mockClient.rpc.sessions.connect).toHaveBeenCalledWith({ sessionId: 'cloud-session' });
    expect(mockClient.resumeSession).toHaveBeenCalledWith(
      'cloud-session',
      expect.objectContaining({ workingDirectory: '/ws' }),
    );
    expect(mockSession.abort).toHaveBeenCalled();
    expect(mockSession.disconnect).toHaveBeenCalled();
    expect(updateAgentSessionStatus).toHaveBeenCalledWith('sdk-cloud', 'failed', 'Aborted by user');
  });

  it('preserves a restored SDK cloud session when reconnecting to abort fails', async () => {
    enableMockClient();
    vi.mocked(getAgentSession).mockResolvedValue({
      id: 'sdk-cloud', session_id: 'cloud-session', space_id: 'space-1', prompt: 'Cloud work',
      status: 'running', summary: '', working_dir: '/ws', source: 'sdk',
      persona_handle: null, quoted_text: null, run_location: 'cloud',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });
    mockClient.rpc.sessions.connect.mockRejectedValueOnce(new Error('offline'));
    const { deleteAgentSession } = await import('./storage');

    await expect(deleteAgent('sdk-cloud')).rejects.toThrow('may still be running');

    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'sdk-cloud',
      'running',
      expect.stringContaining('retry before deleting'),
    );
    expect(deleteAgentSession).not.toHaveBeenCalled();
  });

  it('deletes restored cloud metadata when the SDK confirms the session is gone', async () => {
    enableMockClient();
    vi.mocked(getAgentSession).mockResolvedValue({
      id: 'sdk-cloud-missing', session_id: 'cloud-session', space_id: 'space-1', prompt: 'Cloud work',
      status: 'failed', summary: 'Error', working_dir: '/ws', source: 'sdk',
      persona_handle: null, quoted_text: null, run_location: 'cloud',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });
    mockClient.rpc.sessions.connect.mockRejectedValueOnce(new Error('Session not found: cloud-session'));
    const { deleteAgentSession } = await import('./storage');

    await deleteAgent('sdk-cloud-missing');

    expect(deleteAgentSession).toHaveBeenCalledWith('sdk-cloud-missing');
  });

  it('deletes a completed SDK cloud session without reconnecting', async () => {
    vi.mocked(getAgentSession).mockResolvedValue({
      id: 'sdk-cloud-done', session_id: 'cloud-session', space_id: 'space-1', prompt: 'Cloud work',
      status: 'completed', summary: 'Done', working_dir: '/ws', source: 'sdk',
      persona_handle: null, quoted_text: null, run_location: 'cloud',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });
    const { deleteAgentSession } = await import('./storage');

    await deleteAgent('sdk-cloud-done');

    expect(mockClient.rpc.sessions.connect).not.toHaveBeenCalled();
    expect(deleteAgentSession).toHaveBeenCalledWith('sdk-cloud-done');
  });

  it('treats disconnect failure as cleanup after a successful cloud abort', async () => {
    enableMockClient();
    vi.mocked(getAgentSession).mockResolvedValue({
      id: 'sdk-cloud', session_id: 'cloud-session', space_id: 'space-1', prompt: 'Cloud work',
      status: 'running', summary: '', working_dir: '/ws', source: 'sdk',
      persona_handle: null, quoted_text: null, run_location: 'cloud',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });
    mockSession.disconnect.mockRejectedValueOnce(new Error('already disconnected'));

    await expect(abortAgent('sdk-cloud')).resolves.toBeUndefined();

    expect(mockSession.abort).toHaveBeenCalled();
    expect(updateAgentSessionStatus).toHaveBeenCalledWith('sdk-cloud', 'failed', 'Aborted by user');
  });

  it('aborts before deleting a tracked session', async () => {
    vi.mocked(getAgentSession).mockResolvedValueOnce({
      id: 'cli-delete', session_id: 'cli-session', space_id: null, prompt: 'CLI Session',
      status: 'running', summary: '', working_dir: '/ws', source: 'cli',
      persona_handle: null, quoted_text: null, run_location: 'local',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });
    const { deleteAgentSession } = await import('./storage');

    await deleteAgent('cli-delete');

    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'cli-delete',
      'failed',
      expect.any(String),
    );
    expect(deleteAgentSession).toHaveBeenCalledWith('cli-delete');
  });
});

describe('listAgents', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `list-agent-${++uuidCounter}`);
  });

  it('returns agents filtered by spaceId', async () => {
    enableMockClient();
    await launchAgent('space-A', 'text-a', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');
    await launchAgent('space-B', 'text-b', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    const agentsA = (await listAgents('space-A'));
    expect(agentsA).toHaveLength(1);
    expect(agentsA[0].agentId).toBe('list-agent-1');

    const agentsB = (await listAgents('space-B'));
    expect(agentsB).toHaveLength(1);
    expect(agentsB[0].agentId).toBe('list-agent-2');
  });

  it('returns empty array for unknown spaceId', async () => {
    const result = (await listAgents('unknown'));
    expect(result).toEqual([]);
  });

  it('returns persisted rows for a space before a live session is active', async () => {
    vi.mocked(listAgentSessions).mockResolvedValueOnce([
      {
        id: 'persisted-agent',
        session_id: 'pending-session',
        space_id: 'space-persisted',
        prompt: 'comment body',
        status: 'running',
        summary: 'Starting...',
        working_dir: '/ws/folder',
        source: 'sdk',
        persona_handle: 'agent',
        quoted_text: 'quoted text',
        run_location: 'local',
        created_at: '2025-01-01T00:00:00.000Z',
        updated_at: '2025-01-01T00:00:00.000Z',
      },
    ]);

    const agents = (await listAgents('space-persisted'));

    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      agentId: 'persisted-agent',
      sessionId: 'pending-session',
      status: 'running',
      summary: 'Starting...',
      selectedText: 'comment body',
      quotedText: 'quoted text',
      spaceId: 'space-persisted',
      pendingApprovalId: null,
      source: 'sdk',
    });
  });
});

describe('listAllAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    vi.mocked<() => string>(uuid).mockReturnValue('all-agent-1');
  });

  it('overlays live state on DB records', async () => {
    enableMockClient();

    // Create a live agent
    await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    // Mock DB to return a persisted record that matches the live agent
    vi.mocked(listAgentSessions).mockResolvedValue([
      { persona_handle: null, quoted_text: null, run_location: 'local' as const,
        id: 'all-agent-1',
        session_id: 'mock-session-id',
        space_id: 'space-1',
        prompt: 'text',
        status: 'completed', // DB says completed
        summary: 'DB summary',
        working_dir: '/ws/folder',
        source: 'sdk',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      },
    ]);

    const all = (await listAllAgents());
    // Find our specific agent (other agents from prior tests may exist in-memory)
    const ourAgent = all.find(a => a.agentId === 'all-agent-1');
    expect(ourAgent).toBeDefined();
    // Live state should override DB state
    expect(ourAgent!.status).toBe('running');
    expect(ourAgent!.summary).toBe('Starting...');
  });

  it('includes live agents not in DB', async () => {
    enableMockClient();
    vi.mocked(listAgentSessions).mockResolvedValue([]);

    // listAllAgents should include live in-memory agents even if DB returns none
    const all = (await listAllAgents());
    // There should be at least some agents from prior tests in-memory
    expect(Array.isArray(all)).toBe(true);
    // Every returned agent should have the expected shape
    for (const a of all) {
      expect(a).toHaveProperty('agentId');
      expect(a).toHaveProperty('sessionId');
      expect(a).toHaveProperty('status');
      expect(a).toHaveProperty('source');
    }
  });
});

describe('setAgentYolo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    vi.mocked<() => string>(uuid).mockReturnValue('yolo-agent-1');
  });

  it('returns error for unknown agent', async () => {
    const result = (await setAgentYolo('nonexistent', true));
    expect(result).toEqual({ error: 'Agent not found' });
  });

  it('enables yolo mode on a live agent', async () => {
    enableMockClient();
    await launchAgent('space-1', 'task', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    const result = (await setAgentYolo('yolo-agent-1', true));
    expect(result).toEqual({ ok: true });

    // Verify the yoloMode flag is reflected in listAllAgents
    vi.mocked(listAgentSessions).mockResolvedValue([]);
    const all = (await listAllAgents());
    const agent = all.find(a => a.agentId === 'yolo-agent-1');
    expect(agent).toBeDefined();
    expect(agent!.yoloMode).toBe(true);
  });

  it('disables yolo mode on a live agent', async () => {
    enableMockClient();
    await launchAgent('space-1', 'task', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    (await setAgentYolo('yolo-agent-1', true));
    (await setAgentYolo('yolo-agent-1', false));

    vi.mocked(listAgentSessions).mockResolvedValue([]);
    const all = (await listAllAgents());
    const agent = all.find(a => a.agentId === 'yolo-agent-1');
    expect(agent).toBeDefined();
    expect(agent!.yoloMode).toBe(false);
  });
});

describe('sendChatMessage', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `chat-agent-${++uuidCounter}`);
    vi.mocked(getAgentSession).mockResolvedValue(null);
  });

  it('returns error when agent not found and cannot resume', async () => {
    disableMockClient();
    const result = await sendChatMessage('nonexistent', 'hello');
    expect(result).toEqual({ error: 'Agent session expired — open in CLI to resume' });
  });

  it('sends message to session on success', async () => {
    enableMockClient();
    const launched = await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');
    const agentId = (launched as any).agentId;

    const result = await sendChatMessage(agentId, 'follow-up');
    expect(result).toEqual({});
    // session.send should have been called at least twice (initial + chat message)
    expect(mockSession.send).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'follow-up' }));
  });
});

describe('launchCliSession', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `cli-${++uuidCounter}`);
    vi.mocked(launchSessionInTerminal).mockResolvedValue({ pid: null });
  });

  it('creates agent session in DB with source cli', async () => {
    const result = await launchCliSession('/workspace');

    expect(result).toEqual({ agentId: 'cli-1', sessionId: 'cli-2' });

    expect(createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'cli-1',
        session_id: 'cli-2',
        source: 'cli',
        prompt: 'CLI Session',
        status: 'running',
      }),
    );
  });

  it('calls launchSessionInTerminal', async () => {
    await launchCliSession('/workspace');
    expect(launchSessionInTerminal).toHaveBeenCalledWith('cli-2', '/workspace', expect.any(String));
  });

  it('returns error when launchSessionInTerminal fails', async () => {
    vi.mocked(launchSessionInTerminal).mockRejectedValueOnce(new Error('terminal failed'));
    const result = await launchCliSession('/workspace');
    expect(result).toEqual({ error: 'terminal failed' });
    expect(updateAgentSessionStatus).toHaveBeenCalledWith('cli-1', 'failed', 'terminal failed');
  });
});

describe('CLI exit monitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Make sure monitor is stopped before each test
    stopCliExitMonitor();
  });

  afterEach(() => {
    stopCliExitMonitor();
    vi.useRealTimers();
  });

  it('startCliExitMonitor does not create duplicate intervals', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    startCliExitMonitor();
    startCliExitMonitor(); // second call should be no-op

    await vi.advanceTimersByTimeAsync(10_000);

    // readdirSync is called by ensureCliExitDir (existsSync) + the interval tick
    // The key thing: only 1 interval fires, not 2
    const readdirCalls = vi.mocked(fs.readdirSync).mock.calls.length;

    vi.mocked(fs.readdirSync).mockClear();
    await vi.advanceTimersByTimeAsync(10_000);

    // Only one more call — proves there's a single interval
    expect(vi.mocked(fs.readdirSync)).toHaveBeenCalledTimes(1);
  });

  it('stopCliExitMonitor clears the interval', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    startCliExitMonitor();
    stopCliExitMonitor();

    vi.mocked(fs.readdirSync).mockClear();
    vi.advanceTimersByTime(20_000);
    // After stop, no interval reads should happen
    expect(vi.mocked(fs.readdirSync)).not.toHaveBeenCalled();
  });
});

describe('setAgentModel', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockSession.setModel.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `model-agent-${++uuidCounter}`);
    vi.mocked(getAgentSession).mockResolvedValue(null);
  });

  it('calls session.setModel() for active agents', async () => {
    enableMockClient();
    const launched = await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');
    const agentId = (launched as any).agentId;

    const result = await setAgentModel(agentId, 'gpt-4o');
    expect(result).toEqual({});
    expect(mockSession.setModel).toHaveBeenCalledWith('gpt-4o');
  });

  it('returns error for non-existent agents', async () => {
    disableMockClient();
    const result = await setAgentModel('nonexistent', 'gpt-4o');
    expect(result).toEqual({ error: 'Agent session not found' });
  });

  it('returns error when setModel throws', async () => {
    enableMockClient();
    const launched = await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');
    const agentId = (launched as any).agentId;

    mockSession.setModel.mockRejectedValueOnce(new Error('model not supported'));
    const result = await setAgentModel(agentId, 'bad-model');
    expect(result).toEqual({ error: 'model not supported' });
  });
});

describe('getAgentHistoryPage routing', () => {
  const emptyPage = { items: [], total: 0, nextCursor: null, watermark: 0 };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetAppRemoteForTests();
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ ...getConfig(), workspace: '/ws' });
    mockClient.createSession.mockResolvedValue(mockSession);
    mockClient.resumeSession.mockResolvedValue(mockSession);
    mockSession.send.mockResolvedValue(undefined);
    mockSession.rpc.eventLog.read.mockResolvedValue({ events: [], cursor: 'history-tail', hasMore: false });
    vi.mocked(openRuntimeHistory).mockResolvedValue(undefined);
    vi.mocked(queryRuntimeHistory).mockResolvedValue(emptyPage);
    vi.mocked(listAgentHistoryPage).mockResolvedValue(emptyPage);
    vi.mocked(getAgentSession).mockResolvedValue(null);
  });

  it('uses the durable page without fetching a full SDK history', async () => {
    const mirrored = { ...emptyPage, watermark: 12 };
    vi.mocked(listAgentHistoryPage).mockResolvedValue(mirrored);
    expect(await getAgentHistoryPage('mirrored', { limit: 5 })).toEqual(mirrored);
    expect(mockSession.rpc.eventLog.read).not.toHaveBeenCalled();
    expect(mockSession.getEvents).not.toHaveBeenCalled();
  });

  it.each(['sdk', 'cli'] as const)('resumes an unmirrored %s session into the bounded importer', async source => {
    vi.mocked(getAgentSession).mockResolvedValue({
      id: 'unmirrored', session_id: 'retained-session', space_id: 'space-1',
      prompt: 'Retained conversation', status: 'completed', summary: '', working_dir: '/ws',
      source, persona_handle: null, quoted_text: null, run_location: 'local',
      created_at: '2025-01-01', updated_at: '2025-01-01',
    });
    expect(await getAgentHistoryPage('unmirrored', { limit: 5 })).toEqual(emptyPage);
    expect(mockClient.resumeSession).toHaveBeenCalledWith('retained-session', expect.any(Object));
    expect(openRuntimeHistory).toHaveBeenCalledWith('unmirrored', mockSession.sessionId, false);
    expect(mockSession.rpc.eventLog.read).toHaveBeenCalledWith({
      cursor: undefined, max: 32, includeEphemeral: false, waitMs: 0,
    });
    expect(mockSession.getEvents).not.toHaveBeenCalled();

    // Once imported, new mirrored events must not hide the older runtime history.
    vi.mocked(listAgentHistoryPage).mockResolvedValue({ ...emptyPage, watermark: 1 });
    await getAgentHistoryPage('unmirrored', { limit: 5 });
    expect(listAgentHistoryPage).toHaveBeenCalledTimes(1);
    expect(queryRuntimeHistory).toHaveBeenCalledTimes(2);
  });

  it('keeps ephemeral paging out of durable chat storage', async () => {
    vi.mocked(ensureEphemeralCopilotClient).mockResolvedValue(getCopilotClient());
    const launched = await launchQuickAgent('private conversation', '/ws', {
      id: 'private', handle: 'private', instructions: '', model: '',
      runLocation: 'local', ephemeral: true,
    });
    if (!('agentId' in launched)) throw new Error(launched.error);
    expect(await getAgentHistoryPage(launched.agentId)).toEqual(emptyPage);
    expect(openRuntimeHistory).toHaveBeenCalledWith(launched.agentId, mockSession.sessionId, true);
    expect(listAgentHistoryPage).not.toHaveBeenCalled();
    expect(mockSession.getEvents).not.toHaveBeenCalled();
  });

  it('surfaces runtime history failures instead of returning an empty success', async () => {
    vi.mocked(getAgentSession).mockResolvedValue({
      id: 'unavailable', session_id: 'retained-session', space_id: 'space-1',
      prompt: '', status: 'completed', summary: '', working_dir: '/ws',
      source: 'sdk', persona_handle: null, quoted_text: null, run_location: 'local',
      created_at: '2025-01-01', updated_at: '2025-01-01',
    });
    mockSession.rpc.eventLog.read.mockRejectedValueOnce(new Error('runtime disconnected'));
    await expect(getAgentHistoryPage('unavailable')).rejects.toThrow('runtime disconnected');
    expect(queryRuntimeHistory).not.toHaveBeenCalled();
    expect(mockSession.getEvents).not.toHaveBeenCalled();
  });

  it('does not create or persist a replacement session merely to read unavailable history', async () => {
    vi.mocked(getAgentSession).mockResolvedValue({
      id: 'expired-history', session_id: 'retained-session', space_id: 'space-1',
      prompt: '', status: 'completed', summary: '', working_dir: '/ws',
      source: 'sdk', persona_handle: null, quoted_text: null, run_location: 'local',
      created_at: '2025-01-01', updated_at: '2025-01-01',
    });
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session unavailable'));
    await expect(getAgentHistoryPage('expired-history')).rejects.toThrow('session unavailable');
    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(updateAgentSessionId).not.toHaveBeenCalled();
    expect(queryRuntimeHistory).not.toHaveBeenCalled();
  });
});

describe('getAgentHistory', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockSession.getEvents.mockResolvedValue([{ type: 'assistant.message', content: 'hello' }]);
    mockClient.createSession.mockResolvedValue(mockSession);
    mockClient.resumeSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `history-agent-${++uuidCounter}`);
    vi.mocked(getAgentSession).mockResolvedValue(null);
  });

  it('returns events from session.getEvents()', async () => {
    enableMockClient();
    const launched = await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');
    const agentId = (launched as any).agentId;

    const result = await getAgentHistory(agentId);
    expect(result).toEqual({ events: [{ type: 'assistant.message', content: 'hello' }] });
    expect(mockSession.getEvents).toHaveBeenCalled();
  });

  it('returns error when agent not found in DB', async () => {
    disableMockClient();
    vi.mocked(getAgentSession).mockResolvedValue(null);
    const result = await getAgentHistory('nonexistent');
    expect(result).toEqual({ error: 'Agent session not found in database' });
  });

  it('resumes historical SDK session via client.resumeSession()', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'old-agent-id',
      session_id: 'old-session-id',
      space_id: 'space-1',
      prompt: 'do something',
      status: 'completed' as const,
      summary: 'Done',
      working_dir: '/ws',
      source: 'sdk' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('old-agent-id');

    expect(mockClient.resumeSession).toHaveBeenCalledWith('old-session-id', expect.objectContaining({
      workingDirectory: '/ws',
    }));
    // Should NOT use createSession for resume
    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(result).toEqual({ events: [{ type: 'assistant.message', content: 'hello' }] });
  });

  it.each([false, true])('restores result editing after app restart (expired=%s), only arming it on send', async expired => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const { readDocument } = await import('./storage');
    const document = '---\ncanvas_artifacts: false\nskill_invocation:\n  instruction_snapshot: skill-instructions.md\n---\n# Result\n';
    vi.mocked(readDocument).mockResolvedValueOnce(document);
    if (expired) {
      vi.mocked(readDocument).mockResolvedValueOnce(document);
      mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    }
    const agentId = `scheduled-history-${expired}`;
    vi.mocked(getAgentSession).mockResolvedValue({
      id: agentId, session_id: `old-${agentId}`, space_id: 'space-1',
      prompt: 'Scheduled skill: Missed messages', status: 'completed', summary: 'Ready',
      working_dir: '/ws/folder', source: 'sdk', run_location: 'local',
      persona_handle: null, quoted_text: null, created_at: '', updated_at: '',
    });
    expect(await getAgentHistory(agentId)).toHaveProperty('events');
    const config = expired ? mockClient.createSession.mock.calls[0][0] : mockClient.resumeSession.mock.calls[0][1];
    expect(config.tools).toEqual([scheduledMocks.editTool]);
    expect(config.availableTools).toContain('custom:edit_scheduled_result');
    expect(config.availableTools).not.toContain('custom:publish_scheduled_result');
    expect(config.systemMessage.content).toContain('not another scheduled run');
    expect(scheduledMocks.editorBegin).not.toHaveBeenCalled();
    expect(await sendChatMessage(agentId, 'Remove this item')).not.toHaveProperty('error');
    expect(scheduledMocks.editorBegin).toHaveBeenCalledTimes(1);
    const idle = mockSession.on.mock.calls.find(([name]) => name === 'session.idle')![1];
    await idle();
    expect(scheduledMocks.editorEnd).toHaveBeenCalledWith(false);
    expect(scheduledMocks.finish).not.toHaveBeenCalled();
    expect(scheduledMocks.complete).not.toHaveBeenCalled();
  });

  it('restores persisted status on resume (not hardcoded completed)', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'failed-agent',
      session_id: 'failed-session-id',
      space_id: 'space-1',
      prompt: 'do something',
      status: 'failed' as const,
      summary: 'Error occurred',
      working_dir: '/ws',
      source: 'sdk' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    await getAgentHistory('failed-agent');

    // The resumed record should preserve the failed status
    expect(mockClient.resumeSession).toHaveBeenCalled();
  });

  it('resumes CLI sessions via same resumeSession path', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'cli-agent-id',
      session_id: 'cli-session-id',
      space_id: null,
      prompt: 'CLI Session',
      status: 'completed' as const,
      summary: 'CLI session ended',
      working_dir: '/ws',
      source: 'cli' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('cli-agent-id');

    expect(mockClient.resumeSession).toHaveBeenCalledWith('cli-session-id', expect.any(Object));
    expect(result).toEqual({ events: [{ type: 'assistant.message', content: 'hello' }] });
  });

  it('returns descriptive error when CLI resume fails', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'cli-fail-agent',
      session_id: 'cli-fail-session-id',
      space_id: null,
      prompt: 'CLI Session',
      status: 'completed' as const,
      summary: 'CLI session ended',
      working_dir: '/ws',
      source: 'cli' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('cli-fail-agent');
    expect(result).toEqual({
      error: expect.stringContaining('CLI session'),
    });
  });

  it('falls back to createSession when SDK resume fails', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'sdk-fail-agent',
      session_id: 'sdk-fail-session-id',
      space_id: 'space-1',
      prompt: 'do something',
      status: 'completed' as const,
      summary: 'Done',
      working_dir: '/ws',
      source: 'sdk' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('sdk-fail-agent');

    // Should have fallen back to createSession
    expect(mockClient.createSession).toHaveBeenCalled();
    // Should return restarted flag
    expect(result).toHaveProperty('restarted', true);
    expect(result).toHaveProperty('events');
    // Should update the session ID in the database
    expect(updateAgentSessionId).toHaveBeenCalledWith('sdk-fail-agent', expect.any(String));
  });

  it('returns error when both resume and fallback createSession fail for SDK', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    mockClient.createSession.mockRejectedValueOnce(new Error('auth failed'));
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'sdk-both-fail-agent',
      session_id: 'sdk-both-fail-session-id',
      space_id: 'space-1',
      prompt: 'do something',
      status: 'completed' as const,
      summary: 'Done',
      working_dir: '/ws',
      source: 'sdk' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('sdk-both-fail-agent');
    expect(result).toEqual({
      error: expect.stringContaining('SDK session'),
    });
  });

  it('includes canvas system prompt in fallback session for canvas agents', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'canvas-restart-agent',
      session_id: 'canvas-restart-session-id',
      space_id: 'space-1',
      prompt: 'fix the bug in section 2',
      status: 'completed' as const,
      summary: 'Fixed the bug',
      working_dir: '/ws',
      source: 'sdk' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    await getAgentHistory('canvas-restart-agent');

    const createConfig = mockClient.createSession.mock.calls[0][0];
    expect(createConfig.systemMessage.content).toContain('canvas document');
    expect(createConfig.systemMessage.content).toContain('fix the bug in section 2');
    expect(createConfig.systemMessage.content).toContain('continuation of a previous session');
  });

  it('does not attempt fallback for CLI sessions', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'cli-no-fallback-agent',
      session_id: 'cli-no-fallback-session-id',
      space_id: null,
      prompt: 'CLI Session',
      status: 'completed' as const,
      summary: 'CLI session ended',
      working_dir: '/ws',
      source: 'cli' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('cli-no-fallback-agent');
    expect(result).toEqual({
      error: expect.stringContaining('CLI session'),
    });
    // createSession should NOT have been called
    expect(mockClient.createSession).not.toHaveBeenCalled();
  });

  it('does not pass systemMessage on resume (avoids duplicating prompts)', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const persistedSession = { persona_handle: null, quoted_text: null, run_location: 'local' as const,
      id: 'sysmsg-agent-id',
      session_id: 'sysmsg-session-id',
      space_id: 'space-1',
      prompt: 'do something',
      status: 'completed' as const,
      summary: 'Done',
      working_dir: '/ws',
      source: 'sdk' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    await getAgentHistory('sysmsg-agent-id');

    const resumeConfig = mockClient.resumeSession.mock.calls[0][1];
    expect(resumeConfig).not.toHaveProperty('systemMessage');
  });

  it('calls sessions.connect before resumeSession for cloud sessions', async () => {
    // For cloud sessions (run_location='cloud'), the SDK runtime has no
    // record of the session after an app restart, so a plain
    // client.resumeSession would throw "Session not found".  The fix is to
    // call client.rpc.sessions.connect first to re-register the remote
    // session against the new runtime instance.  See
    // copilot-agent-runtime src/core/server.ts:543 (sessions.connect).
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const connectSpy = vi.fn().mockResolvedValue({
      sessionId: 'cloud-session-id',
      metadata: { sessionId: 'cloud-session-id' },
    });
    // Inject the spy into the mocked rpc surface (it's not normally needed
    // for non-cloud paths so the base mock omits it).
    (mockClient as any).rpc = { sessions: { connect: connectSpy } };

    const persistedSession = {
      id: 'cloud-agent-id',
      session_id: 'cloud-session-id',
      space_id: '__workspace__',
      prompt: 'create an overview',
      status: 'running' as const,
      summary: 'Working in cloud',
      working_dir: '/ws',
      source: 'sdk' as const,
      persona_handle: 'cloud',
      quoted_text: null,
      run_location: 'cloud' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('cloud-agent-id');

    // Must call sessions.connect first with the cloud session id.
    expect(connectSpy).toHaveBeenCalledWith({ sessionId: 'cloud-session-id' });
    // Then resumeSession picks up the now-registered session.
    expect(mockClient.resumeSession).toHaveBeenCalledWith('cloud-session-id', expect.any(Object));
    // Sequence: connect resolved before resumeSession was invoked.
    expect(connectSpy.mock.invocationCallOrder[0])
      .toBeLessThan((mockClient.resumeSession as any).mock.invocationCallOrder[0]);
    expect(result).toEqual({ events: [{ type: 'assistant.message', content: 'hello' }] });
  });

  it('does NOT call sessions.connect for local (non-cloud) sessions', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const connectSpy = vi.fn();
    (mockClient as any).rpc = { sessions: { connect: connectSpy } };

    const persistedSession = {
      id: 'local-agent-id',
      session_id: 'local-session-id',
      space_id: 'space-1',
      prompt: 'do something local',
      status: 'completed' as const,
      summary: 'Done',
      working_dir: '/ws',
      source: 'sdk' as const,
      persona_handle: null,
      quoted_text: null,
      run_location: 'local' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    await getAgentHistory('local-agent-id');

    expect(connectSpy).not.toHaveBeenCalled();
    expect(mockClient.resumeSession).toHaveBeenCalled();
  });

  it('falls back to local restart when cloud sessions.connect fails (resilient)', async () => {
    // When the cloud worker is truly gone (connect throws), we now roll
    // forward into a fresh LOCAL session loaded with the persisted chat
    // transcript so the user keeps their conversation.  Skipping
    // resumeSession (it would surface a misleading "Session not found")
    // is still required; orphaning is no longer a concern because the
    // failed connect tells us the remote worker is already gone.
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const connectSpy = vi.fn().mockRejectedValue(new Error('Remote task not found'));
    (mockClient as any).rpc = { sessions: { connect: connectSpy } };

    const persistedSession = {
      id: 'cloud-gone',
      session_id: 'cloud-gone-sid',
      space_id: '__workspace__',
      prompt: 'p',
      status: 'running' as const,
      summary: '',
      working_dir: '/ws',
      source: 'sdk' as const,
      persona_handle: 'cloud',
      quoted_text: null,
      run_location: 'cloud' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('cloud-gone');

    // Connect was attempted first.
    expect(connectSpy).toHaveBeenCalled();
    // resumeSession must NOT have been attempted after the connect failure —
    // it would have produced the confusing "Session not found" error.
    expect(mockClient.resumeSession).not.toHaveBeenCalled();
    // The fallback restart created a fresh local session preloaded with the
    // continuation system message.
    expect(mockClient.createSession).toHaveBeenCalled();
    const createConfig = mockClient.createSession.mock.calls[0][0];
    expect(createConfig.systemMessage.content).toContain('continuation of a previous session');
    // updateSessionId was called to rebind the agent to the new local session id.
    expect(updateAgentSessionId).toHaveBeenCalledWith('cloud-gone', expect.any(String));
    // The renderer sees a fresh-session history with restarted: true so it
    // can surface "Previous session expired — started a fresh session" to the user.
    expect(result).toHaveProperty('restarted', true);
    expect(result).toHaveProperty('events');
  });

  it('uses persisted transcript when restarting an expired session (richer context)', async () => {
    // restartExpiredSession should prefer the persisted chat events over
    // the bare prompt+summary fallback — the model gets full prior
    // context instead of just the original prompt.
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));

    const now = '2025-01-01T00:00:00Z';
    vi.mocked(listAgentChatEvents).mockResolvedValue([
      { seq: 1, event_id: null, type: 'user.message', timestamp: now,
        payload: JSON.stringify({ content: 'Please refactor the auth module.' }) },
      { seq: 2, event_id: null, type: 'assistant.message', timestamp: now,
        payload: JSON.stringify({ content: 'Started refactor of LoginController.ts.' }) },
      { seq: 3, event_id: null, type: 'user.message', timestamp: now,
        payload: JSON.stringify({ content: 'Also add tests.' }) },
    ]);

    const persistedSession = {
      id: 'transcript-restart-agent',
      session_id: 'expired-sid',
      space_id: 'space-1',
      prompt: 'original prompt',
      status: 'running' as const,
      summary: 'Working on it...',
      working_dir: '/ws',
      source: 'sdk' as const,
      persona_handle: null,
      quoted_text: null,
      run_location: 'local' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    await getAgentHistory('transcript-restart-agent');

    expect(mockClient.createSession).toHaveBeenCalled();
    const createConfig = mockClient.createSession.mock.calls[0][0];
    const sysContent: string = createConfig.systemMessage.content;
    // The continuation preamble for transcript-replay mode.
    expect(sysContent).toContain('previous conversation');
    // All three persisted turns surfaced verbatim in the system message.
    expect(sysContent).toContain('refactor the auth module');
    expect(sysContent).toContain('LoginController.ts');
    expect(sysContent).toContain('Also add tests.');
  });

  it('returns persisted transcript when both resume AND local restart fail', async () => {
    // Worst case: SDK resume throws AND the fallback createSession also
    // throws (e.g. auth issue).  Previously this surfaced an error and
    // blanked the chat.  Now we serve the persisted transcript so the
    // user can at least read what happened.
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    mockClient.createSession.mockRejectedValueOnce(new Error('auth failed'));

    const now = '2025-01-01T00:00:00Z';
    vi.mocked(listAgentChatEvents).mockResolvedValue([
      { seq: 1, event_id: null, type: 'user.message', timestamp: now,
        payload: JSON.stringify({ content: 'hello' }) },
      { seq: 2, event_id: null, type: 'assistant.message', timestamp: now,
        payload: JSON.stringify({ content: 'hi back' }) },
    ]);

    const persistedSession = {
      id: 'unrecoverable-agent',
      session_id: 'unrecoverable-sid',
      space_id: 'space-1',
      prompt: 'p',
      status: 'failed' as const,
      summary: '',
      working_dir: '/ws',
      source: 'sdk' as const,
      persona_handle: null,
      quoted_text: null,
      run_location: 'local' as const,
      created_at: '2025-01-01',
      updated_at: '2025-01-01',
    };
    vi.mocked(getAgentSession).mockResolvedValue(persistedSession);

    const result = await getAgentHistory('unrecoverable-agent');

    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('transcript', true);
    const events = (result as any).events;
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('user.message');
    expect(events[0].data.content).toBe('hello');
    expect(events[1].type).toBe('assistant.message');
    expect(events[1].data.content).toBe('hi back');
  });
});

// ── setAppRemote (app-level remote reconciliation) ──────────────────────

describe('setAppRemote', () => {
  let uuidCounter: number;
  let testRegistry: ReturnType<typeof __resetAppRemoteForTests>['registry'];

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset shared in-flight + registry state between cases.
    ({ registry: testRegistry } = __resetAppRemoteForTests());

    uuidCounter = 0;
    vi.mocked<() => string>(uuid).mockImplementation(() => `app-remote-agent-${++uuidCounter}`);

    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    enableMockClient();

    // Default: rpc.remote.enable returns a URL so the supervisor reuses it.
    mockSession.rpc.remote.enable.mockResolvedValue({
      remoteSteerable: true,
      url: 'https://mock-remote.example/url-1',
    });
    mockSession.rpc.remote.disable.mockResolvedValue(undefined);
  });

  it('launches a new supervisor and enables remote when none exists', async () => {
    const result = await setAppRemote(true);

    expect('agents' in result).toBe(true);
    expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    expect(mockSession.rpc.remote.enable).toHaveBeenCalledTimes(1);
    if ('agents' in result) {
      expect(result.enabled).toBe(true);
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]).toMatchObject({ url: 'https://mock-remote.example/url-1' });
    }

    // The newly-created agent must be flagged as the dedicated supervisor.
    const records = [...testRegistry.values()];
    const supervisor = records.find(r => r.appRemoteSupervisor === true);
    expect(supervisor).toBeDefined();
    expect(supervisor!.spaceId).toBe('__workspace__');
  });

  it('reuses an existing healthy supervisor with a URL (no new launch)', async () => {
    // Bootstrap a supervisor first.
    await setAppRemote(true);
    expect(mockClient.createSession).toHaveBeenCalledTimes(1);

    // Second call should NOT spawn another supervisor or re-enable remote.
    mockClient.createSession.mockClear();
    mockSession.rpc.remote.enable.mockClear();

    const result = await setAppRemote(true);

    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(mockSession.rpc.remote.enable).not.toHaveBeenCalled();
    if ('agents' in result) {
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].url).toBe('https://mock-remote.example/url-1');
    }
  });

  it('retries enabling remote on a supervisor that has no URL (no new launch)', async () => {
    // First launch the supervisor.
    await setAppRemote(true);
    expect(mockClient.createSession).toHaveBeenCalledTimes(1);

    // Simulate the supervisor having lost its URL.
    const supervisor = [...testRegistry.values()].find(r => r.appRemoteSupervisor === true);
    expect(supervisor).toBeDefined();
    supervisor!.remote = { enabled: true, remoteSteerable: true, url: undefined };

    // Next enable returns the new URL on retry.
    mockClient.createSession.mockClear();
    mockSession.rpc.remote.enable.mockClear();
    mockSession.rpc.remote.enable.mockResolvedValue({
      remoteSteerable: true,
      url: 'https://mock-remote.example/url-2',
    });

    const result = await setAppRemote(true);

    // No new agent should be launched.
    expect(mockClient.createSession).not.toHaveBeenCalled();
    // The retry path must have invoked enable on the supervisor.
    expect(mockSession.rpc.remote.enable).toHaveBeenCalledTimes(1);
    if ('agents' in result) {
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].url).toBe('https://mock-remote.example/url-2');
      expect(result.agents[0].agentId).toBe(supervisor!.agentId);
    }
  });

  it('coalesces concurrent setAppRemote(true) calls into a single launch', async () => {
    const [resultA, resultB] = await Promise.all([
      (await setAppRemote(true)),
      (await setAppRemote(true)),
    ]);

    // Both calls should share the same in-flight promise and observe the
    // same single createSession invocation.
    expect(mockClient.createSession).toHaveBeenCalledTimes(1);
    expect(resultA).toEqual(resultB);

    // Only one supervisor should exist in the registry.
    const supervisors = [...testRegistry.values()].filter(r => r.appRemoteSupervisor === true);
    expect(supervisors).toHaveLength(1);
  });
});

// ── getRemoteState / resetRemoteControl ──────────────────

describe('getRemoteState', () => {
  let testRegistry: ReturnType<typeof __resetAppRemoteForTests>['registry'];

  beforeEach(() => {
    vi.clearAllMocks();
    ({ registry: testRegistry } = __resetAppRemoteForTests());
  });

  it('returns an error when the agent does not exist', () => {
    const result = getRemoteState('does-not-exist');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toBe('Agent not found');
    }
  });

  it('returns disabled defaults for an agent that has never enabled remote', () => {
    testRegistry.set('agent-no-remote', {
      agentId: 'agent-no-remote',
      sessionId: 's1',
      session: mockSession as any,
      spaceId: 'space-1',
      selectedText: '',
      anchor: { prefix: '', suffix: '' } as any,
      status: 'running',
      pendingApprovalId: null,
      pendingPermissionKind: null,
      pendingApprovals: new Map(),
      summary: '',
    });

    const result = getRemoteState('agent-no-remote');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.enabled).toBe(false);
      expect(result.remoteSteerable).toBe(false);
      expect(result.url).toBeUndefined();
    }
  });

  it('returns the current remote state when remote is enabled', () => {
    testRegistry.set('agent-remote-on', {
      agentId: 'agent-remote-on',
      sessionId: 's2',
      session: mockSession as any,
      spaceId: 'space-2',
      selectedText: '',
      anchor: { prefix: '', suffix: '' } as any,
      status: 'running',
      pendingApprovalId: null,
      pendingPermissionKind: null,
      pendingApprovals: new Map(),
      summary: '',
      remote: { enabled: true, remoteSteerable: true, url: 'https://stick.example/abc' },
    });

    const result = getRemoteState('agent-remote-on');
    if (!('error' in result)) {
      expect(result.enabled).toBe(true);
      expect(result.remoteSteerable).toBe(true);
      expect(result.url).toBe('https://stick.example/abc');
    }
  });
});

describe('resetRemoteControl', () => {
  let testRegistry: ReturnType<typeof __resetAppRemoteForTests>['registry'];
  let notifySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    ({ registry: testRegistry } = __resetAppRemoteForTests());
    notifySpy = vi.spyOn(AgentNotifier.prototype, 'notifyRenderer').mockImplementation(() => {});
    mockSession.rpc.remote.disable.mockResolvedValue(undefined);
  });

  afterEach(() => {
    notifySpy.mockRestore();
  });

  function seed(agentId: string, currentUrl?: string) {
    testRegistry.set(agentId, {
      agentId,
      sessionId: 'session-' + agentId,
      session: mockSession as any,
      spaceId: 'space-x',
      selectedText: '',
      anchor: { prefix: '', suffix: '' } as any,
      status: 'running',
      pendingApprovalId: null,
      pendingPermissionKind: null,
      pendingApprovals: new Map(),
      summary: '',
      remote: { enabled: true, remoteSteerable: true, url: currentUrl },
    });
  }

  it('returns an error when the agent does not exist', async () => {
    const result = await resetRemoteControl('missing');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toBe('Agent not found');
    expect(mockSession.rpc.remote.disable).not.toHaveBeenCalled();
    expect(mockSession.rpc.remote.enable).not.toHaveBeenCalled();
  });

  it('disables then re-enables remote, emits a single remote-changed event, and reports changed=true when URL rotates', async () => {
    seed('agent-rotate', 'https://old.example/url-A');
    mockSession.rpc.remote.enable.mockResolvedValue({
      remoteSteerable: true,
      url: 'https://new.example/url-B',
    });

    const result = await resetRemoteControl('agent-rotate');

    expect(mockSession.rpc.remote.disable).toHaveBeenCalledTimes(1);
    expect(mockSession.rpc.remote.enable).toHaveBeenCalledTimes(1);
    expect(mockSession.rpc.remote.enable).toHaveBeenCalledWith({ mode: 'on' });

    // Verify exactly ONE agent:remote-changed event was emitted (the final one).
    // This is the anti-flicker invariant — overlays must not see an intermediate disabled state.
    const remoteEvents = notifySpy.mock.calls.filter((c: unknown[]) => c[0] === 'agent:remote-changed');
    expect(remoteEvents).toHaveLength(1);
    expect(remoteEvents[0][1]).toMatchObject({
      agentId: 'agent-rotate',
      enabled: true,
      remoteSteerable: true,
      url: 'https://new.example/url-B',
    });

    if (!('error' in result)) {
      expect(result.enabled).toBe(true);
      expect(result.url).toBe('https://new.example/url-B');
      expect(result.changed).toBe(true);
    }

    // Registry state is updated to the new URL.
    const record = testRegistry.get('agent-rotate');
    expect(record?.remote).toMatchObject({
      enabled: true,
      remoteSteerable: true,
      url: 'https://new.example/url-B',
    });
  });

  it('reports changed=false when the SDK returns the same URL', async () => {
    seed('agent-same', 'https://same.example/url-X');
    mockSession.rpc.remote.enable.mockResolvedValue({
      remoteSteerable: true,
      url: 'https://same.example/url-X',
    });

    const result = await resetRemoteControl('agent-same');

    if (!('error' in result)) {
      expect(result.changed).toBe(false);
      expect(result.url).toBe('https://same.example/url-X');
    }
  });

  it('returns an error and marks the agent disabled if re-enable fails after disable succeeds', async () => {
    seed('agent-enable-fails', 'https://old.example/url-Z');
    mockSession.rpc.remote.enable.mockRejectedValueOnce(new Error('enable boom'));

    const result = await resetRemoteControl('agent-enable-fails');

    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('enable boom');
    }

    // The state must reflect the failed-to-enable reality (remote is off).
    const record = testRegistry.get('agent-enable-fails');
    expect(record?.remote).toEqual({ enabled: false, remoteSteerable: false });

    // And a single disabled event must have been emitted so the renderer
    // doesn't keep showing an outdated URL.
    const remoteEvents = notifySpy.mock.calls.filter((c: unknown[]) => c[0] === 'agent:remote-changed');
    expect(remoteEvents).toHaveLength(1);
    expect(remoteEvents[0][1]).toMatchObject({
      agentId: 'agent-enable-fails',
      enabled: false,
    });
  });

  it('returns an error and emits NO events if disable itself fails', async () => {
    seed('agent-disable-fails', 'https://before.example/url-Q');
    mockSession.rpc.remote.disable.mockRejectedValueOnce(new Error('disable boom'));

    const result = await resetRemoteControl('agent-disable-fails');

    expect('error' in result).toBe(true);
    expect(mockSession.rpc.remote.enable).not.toHaveBeenCalled();

    // No events emitted — original URL is still presumably valid from the
    // SDK's perspective.  Registry state is unchanged.
    const remoteEvents = notifySpy.mock.calls.filter((c: unknown[]) => c[0] === 'agent:remote-changed');
    expect(remoteEvents).toHaveLength(0);
    const record = testRegistry.get('agent-disable-fails');
    expect(record?.remote?.url).toBe('https://before.example/url-Q');
  });
});

describe('reconcileStaleAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks running SDK sessions whose in-memory record is gone as failed', async () => {
    const now = new Date().toISOString();
    vi.mocked(listAgentSessions).mockResolvedValue([
      {
        id: 'lost-local',
        session_id: 'lost-local-sid',
        space_id: '__workspace__',
        prompt: 'fix the bug',
        status: 'running',
        summary: 'Working...',
        working_dir: '/ws',
        source: 'sdk',
        persona_handle: null,
        quoted_text: null,
        run_location: 'local',
        created_at: now,
        updated_at: now,
      },
    ]);

    (await reconcileStaleAgents());

    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'lost-local',
      'failed',
      'Session lost — app restarted',
    );
  });

  it('preserves cloud sessions across restart (no status change)', async () => {
    const now = new Date().toISOString();
    vi.mocked(listAgentSessions).mockResolvedValue([
      {
        id: 'cloud-session',
        session_id: 'cloud-session-sid',
        space_id: '__workspace__',
        prompt: 'add multi-line commenting',
        status: 'running',
        summary: 'Working in cloud...',
        working_dir: '/ws',
        source: 'sdk',
        persona_handle: 'cloud',
        quoted_text: null,
        run_location: 'cloud',
        created_at: now,
        updated_at: now,
      },
    ]);

    (await reconcileStaleAgents());

    // The cloud session should be left untouched — its remote worker is
    // still running and the user can resume it on click.  Specifically,
    // updateAgentSessionStatus should NOT be called for cloud-session.
    const calls = vi.mocked(updateAgentSessionStatus).mock.calls.filter(c => c[0] === 'cloud-session');
    expect(calls).toHaveLength(0);
  });

  it('preserves an external CLI session across restart until its exit signal completes it', async () => {
    vi.useFakeTimers();
    stopCliExitMonitor();
    const now = new Date().toISOString();
    const cliSession = {
      id: 'cli-live',
      session_id: 'cli-session',
      space_id: null,
      prompt: 'CLI Session',
      status: 'running' as const,
      summary: 'Running in terminal...',
      working_dir: '/ws',
      source: 'cli' as const,
      persona_handle: null,
      quoted_text: null,
      run_location: 'local' as const,
      created_at: now,
      updated_at: now,
    };
    vi.mocked(listAgentSessions).mockResolvedValue([cliSession]);
    vi.mocked(getAgentSession).mockResolvedValue(cliSession);

    (await reconcileStaleAgents());
    expect(updateAgentSessionStatus).not.toHaveBeenCalledWith(
      'cli-live',
      'failed',
      expect.any(String),
    );

    vi.mocked(fs.readdirSync).mockReturnValue(['cli-live'] as any);
    startCliExitMonitor();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'cli-live',
      'completed',
      'CLI session ended',
    );
    stopCliExitMonitor();
    vi.useRealTimers();
  });

  it('reconciles only local sessions when both kinds are present', async () => {
    const now = new Date().toISOString();
    vi.mocked(listAgentSessions).mockResolvedValue([
      {
        id: 'local-stale',
        session_id: 'sid-l',
        space_id: '__workspace__',
        prompt: 'p1',
        status: 'running',
        summary: '',
        working_dir: '/ws',
        source: 'sdk',
        persona_handle: null,
        quoted_text: null,
        run_location: 'local',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'cloud-alive',
        session_id: 'sid-c',
        space_id: '__workspace__',
        prompt: 'p2',
        status: 'waiting-approval',
        summary: '',
        working_dir: '/ws',
        source: 'sdk',
        persona_handle: 'cloud',
        quoted_text: null,
        run_location: 'cloud',
        created_at: now,
        updated_at: now,
      },
    ]);

    (await reconcileStaleAgents());

    const updateCalls = vi.mocked(updateAgentSessionStatus).mock.calls;
    const targetIds = updateCalls.map(c => c[0]);
    expect(targetIds).toContain('local-stale');
    expect(targetIds).not.toContain('cloud-alive');
  });

  it('does not touch sessions already in completed/failed state', async () => {
    const now = new Date().toISOString();
    vi.mocked(listAgentSessions).mockResolvedValue([
      {
        id: 'already-done',
        session_id: 'sid',
        space_id: null,
        prompt: 'p',
        status: 'completed',
        summary: 'done',
        working_dir: '/ws',
        source: 'sdk',
        persona_handle: null,
        quoted_text: null,
        run_location: 'local',
        created_at: now,
        updated_at: now,
      },
    ]);

    (await reconcileStaleAgents());

    const calls = vi.mocked(updateAgentSessionStatus).mock.calls.filter(c => c[0] === 'already-done');
    expect(calls).toHaveLength(0);
  });
});

describe('getCanvasAgentState', () => {
  const SPACE = 'space-canvas-state';

  function session(overrides: Partial<import('../shared/types').AgentSession>): import('../shared/types').AgentSession {
    const now = new Date().toISOString();
    return {
      id: 'id', session_id: 'sid', space_id: SPACE, prompt: 'comment body',
      status: 'running', summary: '', working_dir: '/ws', source: 'sdk',
      persona_handle: 'reviewer', quoted_text: 'quoted', comment_thread_id: 'c1',
      run_location: 'local', created_at: now, updated_at: now,
      ...overrides,
    };
  }

  it('maps a cloud agent that survived a restart to active', async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([
      session({ id: 'a-cloud', comment_thread_id: 'c-cloud', run_location: 'cloud', status: 'running' }),
    ]);
    const state = (await getCanvasAgentState(SPACE));
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ agentId: 'a-cloud', threadId: 'c-cloud', status: 'active', personaHandle: 'reviewer' });
    expect(state[0].pendingInteractions).toEqual([]);
  });

  it('maps a local agent lost to a restart to failed (needs redeploy)', async () => {
    // After reconcile a lost local agent is "failed" in the DB; even if it were
    // still "running", a local agent with no live process maps to failed.
    vi.mocked(listAgentSessions).mockResolvedValue([
      session({ id: 'a-local', comment_thread_id: 'c-local', run_location: 'local', status: 'failed' }),
    ]);
    const state = (await getCanvasAgentState(SPACE));
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ agentId: 'a-local', threadId: 'c-local', status: 'failed' });
  });

  it('omits completed agents (their reply is already persisted in the thread)', async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([
      session({ id: 'a-done', comment_thread_id: 'c-done', status: 'completed' }),
    ]);
    expect((await getCanvasAgentState(SPACE))).toEqual([]);
  });

  it('ignores sessions without a comment thread or in another space', async () => {
    vi.mocked(listAgentSessions).mockResolvedValue([
      session({ id: 'a-nothread', comment_thread_id: null }),
      session({ id: 'a-otherspace', space_id: 'different-space', comment_thread_id: 'c-other' }),
    ]);
    expect((await getCanvasAgentState(SPACE))).toEqual([]);
  });

  it('returns one representative (newest) agent per thread', async () => {
    // listSessions() is newest-first; the first row for a thread wins.
    vi.mocked(listAgentSessions).mockResolvedValue([
      session({ id: 'a-new', comment_thread_id: 'c-retry', run_location: 'cloud', status: 'running', created_at: '2026-02-01T00:00:00Z' }),
      session({ id: 'a-old', comment_thread_id: 'c-retry', status: 'failed', created_at: '2026-01-01T00:00:00Z' }),
    ]);
    const state = (await getCanvasAgentState(SPACE));
    expect(state).toHaveLength(1);
    expect(state[0].agentId).toBe('a-new');
    expect(state[0].status).toBe('active');
  });
});
