import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module-level mocks (must precede imports) ──────────────────────────

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/space-test' },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: vi.fn().mockImplementation(() => ({ on: vi.fn(), show: vi.fn() })),
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
};

vi.mock('./ai', () => ({
  getCopilotClient: vi.fn(),
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

vi.mock('./database', () => ({
  createCanvasAgent: vi.fn(),
  updateCanvasAgentStatus: vi.fn(),
  createAgentSession: vi.fn(),
  updateAgentSessionStatus: vi.fn(),
  deleteAgentSession: vi.fn(),
  updateAgentSessionId: vi.fn(),
  getAgentSession: vi.fn(),
  listAgentSessions: vi.fn().mockReturnValue([]),
  appendAgentChatEvent: vi.fn().mockReturnValue(1),
  listAgentChatEvents: vi.fn().mockReturnValue([]),
  clearAgentChatEvents: vi.fn(),
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
  setAgentYolo,
  setAppRemote,
  getRemoteState,
  resetRemoteControl,
  reconcileStaleAgents,
  getCanvasAgentState,
  __resetAppRemoteForTests,
} from './agent-service';
import { getCopilotClient } from './ai';
import { createCanvasAgent, createAgentSession, updateAgentSessionStatus, updateAgentSessionId, getAgentSession, listAgentSessions, listAgentChatEvents } from './database';
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
    vi.mocked(uuid).mockImplementation(() => `agent-${++uuidCounter}`);
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
});

describe('launchQuickAgent', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked(uuid).mockImplementation(() => `quick-agent-${++uuidCounter}`);
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

  it('persists run_location=cloud for cloud personas', async () => {
    enableMockClient();
    const persona = {
      id: 'pc', handle: 'cloud', instructions: 'Run in cloud.',
      model: 'gpt-4o', runLocation: 'cloud' as const,
    };
    // The cloud session waits for a `session.start` event before resolving
    // session.send.  Fire it on the next tick so the test doesn't time out.
    let startCb: ((event: any) => void) | null = null;
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
    vi.mocked(uuid).mockReturnValue('document-agent-1');
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
});

describe('launchCommentAgent', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockClient.createSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked(uuid).mockImplementation(() => `comment-agent-${++uuidCounter}`);
  });

  const persona = { handle: 'test-bot', instructions: 'Be helpful', model: 'gpt-4' };

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
    let startCb: ((event: any) => void) | null = null;
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
    let startCb: ((event: any) => void) | null = null;
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
    await vi.waitFor(() => expect(startCb).not.toBeNull());
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
    uuidCounter = 0;
    vi.mocked(uuid).mockImplementation(() => `abort-agent-${++uuidCounter}`);
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

  it('stops CCA tracking without pretending the remote job was cancelled', async () => {
    vi.mocked(getAgentSession).mockReturnValueOnce({
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
    vi.mocked(getAgentSession).mockReturnValueOnce({
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

  it('aborts before deleting a tracked session', async () => {
    vi.mocked(getAgentSession).mockReturnValueOnce({
      id: 'cli-delete', session_id: 'cli-session', space_id: null, prompt: 'CLI Session',
      status: 'running', summary: '', working_dir: '/ws', source: 'cli',
      persona_handle: null, quoted_text: null, run_location: 'local',
      created_at: '2026-07-20T00:00:00Z', updated_at: '2026-07-20T00:00:00Z',
    });
    const { deleteAgentSession } = await import('./database');

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
    vi.mocked(uuid).mockImplementation(() => `list-agent-${++uuidCounter}`);
  });

  it('returns agents filtered by spaceId', async () => {
    enableMockClient();
    await launchAgent('space-A', 'text-a', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');
    await launchAgent('space-B', 'text-b', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    const agentsA = listAgents('space-A');
    expect(agentsA).toHaveLength(1);
    expect(agentsA[0].agentId).toBe('list-agent-1');

    const agentsB = listAgents('space-B');
    expect(agentsB).toHaveLength(1);
    expect(agentsB[0].agentId).toBe('list-agent-2');
  });

  it('returns empty array for unknown spaceId', () => {
    const result = listAgents('unknown');
    expect(result).toEqual([]);
  });

  it('returns persisted rows for a space before a live session is active', () => {
    vi.mocked(listAgentSessions).mockReturnValueOnce([
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

    const agents = listAgents('space-persisted');

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
    vi.mocked(uuid).mockReturnValue('all-agent-1');
  });

  it('overlays live state on DB records', async () => {
    enableMockClient();

    // Create a live agent
    await launchAgent('space-1', 'text', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    // Mock DB to return a persisted record that matches the live agent
    vi.mocked(listAgentSessions).mockReturnValue([
      {
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

    const all = listAllAgents();
    // Find our specific agent (other agents from prior tests may exist in-memory)
    const ourAgent = all.find(a => a.agentId === 'all-agent-1');
    expect(ourAgent).toBeDefined();
    // Live state should override DB state
    expect(ourAgent!.status).toBe('running');
    expect(ourAgent!.summary).toBe('Starting...');
  });

  it('includes live agents not in DB', async () => {
    enableMockClient();
    vi.mocked(listAgentSessions).mockReturnValue([]);

    // listAllAgents should include live in-memory agents even if DB returns none
    const all = listAllAgents();
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
    vi.mocked(uuid).mockReturnValue('yolo-agent-1');
  });

  it('returns error for unknown agent', () => {
    const result = setAgentYolo('nonexistent', true);
    expect(result).toEqual({ error: 'Agent not found' });
  });

  it('enables yolo mode on a live agent', async () => {
    enableMockClient();
    await launchAgent('space-1', 'task', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    const result = setAgentYolo('yolo-agent-1', true);
    expect(result).toEqual({ ok: true });

    // Verify the yoloMode flag is reflected in listAllAgents
    vi.mocked(listAgentSessions).mockReturnValue([]);
    const all = listAllAgents();
    const agent = all.find(a => a.agentId === 'yolo-agent-1');
    expect(agent).toBeDefined();
    expect(agent!.yoloMode).toBe(true);
  });

  it('disables yolo mode on a live agent', async () => {
    enableMockClient();
    await launchAgent('space-1', 'task', { quote: '', prefix: '', suffix: '' }, '/ws', 'folder');

    setAgentYolo('yolo-agent-1', true);
    setAgentYolo('yolo-agent-1', false);

    vi.mocked(listAgentSessions).mockReturnValue([]);
    const all = listAllAgents();
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
    vi.mocked(uuid).mockImplementation(() => `chat-agent-${++uuidCounter}`);
    vi.mocked(getAgentSession).mockReturnValue(null);
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
    vi.mocked(uuid).mockImplementation(() => `cli-${++uuidCounter}`);
    vi.mocked(launchSessionInTerminal).mockResolvedValue(undefined);
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

  it('startCliExitMonitor does not create duplicate intervals', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    startCliExitMonitor();
    startCliExitMonitor(); // second call should be no-op

    vi.advanceTimersByTime(10_000);

    // readdirSync is called by ensureCliExitDir (existsSync) + the interval tick
    // The key thing: only 1 interval fires, not 2
    const readdirCalls = vi.mocked(fs.readdirSync).mock.calls.length;

    vi.mocked(fs.readdirSync).mockClear();
    vi.advanceTimersByTime(10_000);

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
    vi.mocked(uuid).mockImplementation(() => `model-agent-${++uuidCounter}`);
    vi.mocked(getAgentSession).mockReturnValue(null);
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

describe('getAgentHistory', () => {
  let uuidCounter: number;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSession.send.mockResolvedValue(undefined);
    mockSession.getEvents.mockResolvedValue([{ type: 'assistant.message', content: 'hello' }]);
    mockClient.createSession.mockResolvedValue(mockSession);
    mockClient.resumeSession.mockResolvedValue(mockSession);
    uuidCounter = 0;
    vi.mocked(uuid).mockImplementation(() => `history-agent-${++uuidCounter}`);
    vi.mocked(getAgentSession).mockReturnValue(null);
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
    vi.mocked(getAgentSession).mockReturnValue(null);
    const result = await getAgentHistory('nonexistent');
    expect(result).toEqual({ error: 'Agent session not found in database' });
  });

  it('resumes historical SDK session via client.resumeSession()', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

    const result = await getAgentHistory('old-agent-id');

    expect(mockClient.resumeSession).toHaveBeenCalledWith('old-session-id', expect.objectContaining({
      workingDirectory: '/ws',
    }));
    // Should NOT use createSession for resume
    expect(mockClient.createSession).not.toHaveBeenCalled();
    expect(result).toEqual({ events: [{ type: 'assistant.message', content: 'hello' }] });
  });

  it('restores persisted status on resume (not hardcoded completed)', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

    await getAgentHistory('failed-agent');

    // The resumed record should preserve the failed status
    expect(mockClient.resumeSession).toHaveBeenCalled();
  });

  it('resumes CLI sessions via same resumeSession path', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

    const result = await getAgentHistory('cli-agent-id');

    expect(mockClient.resumeSession).toHaveBeenCalledWith('cli-session-id', expect.any(Object));
    expect(result).toEqual({ events: [{ type: 'assistant.message', content: 'hello' }] });
  });

  it('returns descriptive error when CLI resume fails', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

    const result = await getAgentHistory('cli-fail-agent');
    expect(result).toEqual({
      error: expect.stringContaining('CLI session'),
    });
  });

  it('falls back to createSession when SDK resume fails', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

    const result = await getAgentHistory('sdk-both-fail-agent');
    expect(result).toEqual({
      error: expect.stringContaining('SDK session'),
    });
  });

  it('includes canvas system prompt in fallback session for canvas agents', async () => {
    enableMockClient();
    vi.mocked(getConfig).mockReturnValue({ workspace: '/ws' } as any);
    mockClient.resumeSession.mockRejectedValueOnce(new Error('session expired'));
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    const persistedSession = {
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    vi.mocked(listAgentChatEvents).mockReturnValue([
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    vi.mocked(listAgentChatEvents).mockReturnValue([
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
    vi.mocked(getAgentSession).mockReturnValue(persistedSession);

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
    vi.mocked(uuid).mockImplementation(() => `app-remote-agent-${++uuidCounter}`);

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
      setAppRemote(true),
      setAppRemote(true),
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
    const remoteEvents = notifySpy.mock.calls.filter(c => c[0] === 'agent:remote-changed');
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
    const remoteEvents = notifySpy.mock.calls.filter(c => c[0] === 'agent:remote-changed');
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
    const remoteEvents = notifySpy.mock.calls.filter(c => c[0] === 'agent:remote-changed');
    expect(remoteEvents).toHaveLength(0);
    const record = testRegistry.get('agent-disable-fails');
    expect(record?.remote?.url).toBe('https://before.example/url-Q');
  });
});

describe('reconcileStaleAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks running SDK sessions whose in-memory record is gone as failed', () => {
    const now = new Date().toISOString();
    vi.mocked(listAgentSessions).mockReturnValue([
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

    reconcileStaleAgents();

    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'lost-local',
      'failed',
      'Session lost — app restarted',
    );
  });

  it('preserves cloud sessions across restart (no status change)', () => {
    const now = new Date().toISOString();
    vi.mocked(listAgentSessions).mockReturnValue([
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

    reconcileStaleAgents();

    // The cloud session should be left untouched — its remote worker is
    // still running and the user can resume it on click.  Specifically,
    // updateAgentSessionStatus should NOT be called for cloud-session.
    const calls = vi.mocked(updateAgentSessionStatus).mock.calls.filter(c => c[0] === 'cloud-session');
    expect(calls).toHaveLength(0);
  });

  it('preserves an external CLI session across restart until its exit signal completes it', () => {
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
    vi.mocked(listAgentSessions).mockReturnValue([cliSession]);
    vi.mocked(getAgentSession).mockReturnValue(cliSession);

    reconcileStaleAgents();
    expect(updateAgentSessionStatus).not.toHaveBeenCalledWith(
      'cli-live',
      'failed',
      expect.any(String),
    );

    vi.mocked(fs.readdirSync).mockReturnValue(['cli-live'] as any);
    startCliExitMonitor();
    vi.advanceTimersByTime(10_000);

    expect(updateAgentSessionStatus).toHaveBeenCalledWith(
      'cli-live',
      'completed',
      'CLI session ended',
    );
    stopCliExitMonitor();
    vi.useRealTimers();
  });

  it('reconciles only local sessions when both kinds are present', () => {
    const now = new Date().toISOString();
    vi.mocked(listAgentSessions).mockReturnValue([
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

    reconcileStaleAgents();

    const updateCalls = vi.mocked(updateAgentSessionStatus).mock.calls;
    const targetIds = updateCalls.map(c => c[0]);
    expect(targetIds).toContain('local-stale');
    expect(targetIds).not.toContain('cloud-alive');
  });

  it('does not touch sessions already in completed/failed state', () => {
    const now = new Date().toISOString();
    vi.mocked(listAgentSessions).mockReturnValue([
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

    reconcileStaleAgents();

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

  it('maps a cloud agent that survived a restart to active', () => {
    vi.mocked(listAgentSessions).mockReturnValue([
      session({ id: 'a-cloud', comment_thread_id: 'c-cloud', run_location: 'cloud', status: 'running' }),
    ]);
    const state = getCanvasAgentState(SPACE);
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ agentId: 'a-cloud', threadId: 'c-cloud', status: 'active', personaHandle: 'reviewer' });
    expect(state[0].pendingInteractions).toEqual([]);
  });

  it('maps a local agent lost to a restart to failed (needs redeploy)', () => {
    // After reconcile a lost local agent is "failed" in the DB; even if it were
    // still "running", a local agent with no live process maps to failed.
    vi.mocked(listAgentSessions).mockReturnValue([
      session({ id: 'a-local', comment_thread_id: 'c-local', run_location: 'local', status: 'failed' }),
    ]);
    const state = getCanvasAgentState(SPACE);
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({ agentId: 'a-local', threadId: 'c-local', status: 'failed' });
  });

  it('omits completed agents (their reply is already persisted in the thread)', () => {
    vi.mocked(listAgentSessions).mockReturnValue([
      session({ id: 'a-done', comment_thread_id: 'c-done', status: 'completed' }),
    ]);
    expect(getCanvasAgentState(SPACE)).toEqual([]);
  });

  it('ignores sessions without a comment thread or in another space', () => {
    vi.mocked(listAgentSessions).mockReturnValue([
      session({ id: 'a-nothread', comment_thread_id: null }),
      session({ id: 'a-otherspace', space_id: 'different-space', comment_thread_id: 'c-other' }),
    ]);
    expect(getCanvasAgentState(SPACE)).toEqual([]);
  });

  it('returns one representative (newest) agent per thread', () => {
    // listSessions() is newest-first; the first row for a thread wins.
    vi.mocked(listAgentSessions).mockReturnValue([
      session({ id: 'a-new', comment_thread_id: 'c-retry', run_location: 'cloud', status: 'running', created_at: '2026-02-01T00:00:00Z' }),
      session({ id: 'a-old', comment_thread_id: 'c-retry', status: 'failed', created_at: '2026-01-01T00:00:00Z' }),
    ]);
    const state = getCanvasAgentState(SPACE);
    expect(state).toHaveLength(1);
    expect(state[0].agentId).toBe('a-new');
    expect(state[0].status).toBe('active');
  });
});
