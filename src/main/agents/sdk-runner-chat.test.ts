import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentRecord, AgentStatus } from './agent-registry';

const mocks = vi.hoisted(() => {
  const config = { workspace: '/mock/workspace' };
  return {
    config,
    getCopilotClient: vi.fn(),
    getConfig: vi.fn(() => config),
    getAllMcpServers: vi.fn(() => ({})),
    getCustomTools: vi.fn(() => []),
    appendSpaceActivity: vi.fn(),
    listSpaces: vi.fn(() => []),
    updateCanvasContent: vi.fn(),
    listSkills: vi.fn(() => []),
    getWorkspaceRepo: vi.fn(),
    parseFrontmatter: vi.fn(() => ({})),
    resolveRunCanvasConfig: vi.fn(() => null),
    handleCanvasSessionEvent: vi.fn(),
    initCanvasLifecycle: vi.fn(),
    reconcileOpenCanvases: vi.fn(),
    releaseCanvasInstances: vi.fn(),
    endCanvasRun: vi.fn(),
    reportCanvasRun: vi.fn(() => null),
    notifyCanvasRun: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/app', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: vi.fn().mockImplementation(() => ({ on: vi.fn(), show: vi.fn() })),
}));

vi.mock('../ai', () => ({
  getCopilotClient: mocks.getCopilotClient,
  ensureEphemeralCopilotClient: vi.fn(),
}));

vi.mock('../config', () => ({
  getConfig: mocks.getConfig,
  getConfigValue: vi.fn(() => undefined),
}));

vi.mock('../mcp', () => ({
  getAllMcpServers: mocks.getAllMcpServers,
}));

vi.mock('./agent-notifier', () => ({
  AgentNotifier: vi.fn(),
}));

vi.mock('./agent-persistence', () => ({
  AgentPersistence: vi.fn(),
}));

vi.mock('./interaction-broker', () => ({
  InteractionBroker: vi.fn(),
}));

vi.mock('../subagent-service', () => ({}));

vi.mock('../tools', () => ({
  getCustomTools: mocks.getCustomTools,
}));

vi.mock('../space-eventlog', () => ({
  appendSpaceActivity: mocks.appendSpaceActivity,
}));

vi.mock('./sandbox-launch', () => ({
  buildSandboxLaunchSetup: vi.fn(),
}));

vi.mock('./sandbox-policies', () => ({
  SANDBOX_WORKSPACE_SYSTEM_PROMPT: '',
}));

vi.mock('../database', () => ({
  listSpaces: mocks.listSpaces,
  updateCanvasContent: mocks.updateCanvasContent,
  listSkills: mocks.listSkills,
}));

vi.mock('../cloud-agent', () => ({
  getWorkspaceRepo: mocks.getWorkspaceRepo,
}));

vi.mock('../frontmatter', () => ({
  parseFrontmatter: mocks.parseFrontmatter,
}));

vi.mock('../canvas/canvas-launch', () => ({
  resolveRunCanvasConfig: mocks.resolveRunCanvasConfig,
}));

vi.mock('../canvas/canvas-lifecycle', () => ({
  handleCanvasSessionEvent: mocks.handleCanvasSessionEvent,
  initCanvasLifecycle: mocks.initCanvasLifecycle,
  reconcileOpenCanvases: mocks.reconcileOpenCanvases,
  releaseCanvasInstances: mocks.releaseCanvasInstances,
}));

vi.mock('../canvas/canvas-outcome', () => ({
  endCanvasRun: mocks.endCanvasRun,
  reportCanvasRun: mocks.reportCanvasRun,
}));

vi.mock('../canvas/canvas-notifier', () => ({
  notifyCanvasRun: mocks.notifyCanvasRun,
}));

import { AgentRegistry } from './agent-registry';
import { initSdkRunner, sendChatMessage } from './sdk-runner';

function makeSession() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    rpc: { remote: { enable: vi.fn(), disable: vi.fn() } },
  };
}

function makeRecord(
  agentId: string,
  status: AgentStatus,
  session: ReturnType<typeof makeSession> | undefined,
  aborted?: boolean,
): AgentRecord {
  return {
    agentId,
    sessionId: `${agentId}-session`,
    session: session as any,
    spaceId: 'space-1',
    selectedText: 'initial prompt',
    anchor: { quote: '', prefix: '', suffix: '' },
    status,
    aborted,
    pendingApprovalId: null,
    pendingPermissionKind: null,
    pendingApprovals: new Map(),
    summary: 'Test agent',
    runLocation: 'local',
  };
}

function makePersistedSession(agentId: string) {
  return {
    id: agentId,
    session_id: `${agentId}-persisted-session`,
    space_id: 'space-1',
    prompt: 'initial prompt',
    status: 'failed' as const,
    summary: 'Stopped',
    working_dir: '/mock/workspace',
    source: 'sdk' as const,
    persona_handle: null,
    quoted_text: null,
    run_location: 'local' as const,
    created_at: '',
    updated_at: '',
  };
}

describe('sendChatMessage', () => {
  let registry: AgentRegistry;
  let persistence: {
    getSession: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    appendChatEvent: ReturnType<typeof vi.fn>;
  };
  let notifier: { notifyRenderer: ReturnType<typeof vi.fn> };
  let broker: {
    createPermissionHandler: ReturnType<typeof vi.fn>;
    createUserInputHandler: ReturnType<typeof vi.fn>;
    createElicitationHandler: ReturnType<typeof vi.fn>;
  };
  let client: { resumeSession: ReturnType<typeof vi.fn>; rpc: { sessions: { connect: ReturnType<typeof vi.fn> } } };

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new AgentRegistry();
    persistence = {
      getSession: vi.fn(),
      updateStatus: vi.fn(),
      appendChatEvent: vi.fn(),
    };
    notifier = { notifyRenderer: vi.fn() };
    broker = {
      createPermissionHandler: vi.fn(() => vi.fn()),
      createUserInputHandler: vi.fn(() => vi.fn()),
      createElicitationHandler: vi.fn(() => vi.fn()),
    };
    client = {
      resumeSession: vi.fn(),
      rpc: { sessions: { connect: vi.fn() } },
    };
    mocks.getCopilotClient.mockReturnValue(client);

    initSdkRunner({
      registry,
      persistence: persistence as any,
      notifier: notifier as any,
      broker: broker as any,
      subagentTracker: { handleSessionEvent: vi.fn() } as any,
    });
  });

  it('accepts a follow-up message for an agent stopped by the user', async () => {
    const stoppedSession = makeSession();
    const resumedSession = makeSession();
    const agentId = 'stopped-agent';
    registry.set(agentId, makeRecord(agentId, 'failed', stoppedSession, true));
    persistence.getSession.mockReturnValue(makePersistedSession(agentId));
    client.resumeSession.mockResolvedValue(resumedSession);

    const result = await sendChatMessage(agentId, 'continue please');

    expect(result).toEqual({});
    expect(client.resumeSession).toHaveBeenCalledWith(
      `${agentId}-persisted-session`,
      expect.objectContaining({ workingDirectory: '/mock/workspace' }),
    );
    expect(resumedSession.send).toHaveBeenCalledWith({ prompt: 'continue please' });
    const record = registry.get(agentId);
    expect(record?.status).toBe('running');
    expect(record?.aborted).toBe(false);
  });

  it('rejects a genuinely failed agent without resuming it', async () => {
    const session = makeSession();
    const agentId = 'failed-agent';
    registry.set(agentId, makeRecord(agentId, 'failed', session));

    const result = await sendChatMessage(agentId, 'continue please');

    expect(result).toEqual({ error: 'Agent is failed, cannot send message' });
    expect(persistence.getSession).not.toHaveBeenCalled();
    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(session.send).not.toHaveBeenCalled();
  });

  it.each(['running', 'completed'] as const)('sends normally for a %s agent without resuming it', async (status) => {
    const session = makeSession();
    const agentId = `${status}-agent`;
    registry.set(agentId, makeRecord(agentId, status, session));

    const result = await sendChatMessage(agentId, 'continue please');

    expect(result).toEqual({});
    expect(persistence.getSession).not.toHaveBeenCalled();
    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(session.send).toHaveBeenCalledWith({ prompt: 'continue please' });
    expect(registry.get(agentId)?.status).toBe('running');
  });

  it('keeps a stopped agent in the registry when resume fails', async () => {
    const stoppedSession = makeSession();
    const agentId = 'expired-agent';
    const stoppedRecord = makeRecord(agentId, 'failed', stoppedSession, true);
    registry.set(agentId, stoppedRecord);
    persistence.getSession.mockReturnValue(null);

    const result = await sendChatMessage(agentId, 'continue please');

    expect(result).toEqual({ error: 'Agent session expired — open in CLI to resume' });
    expect(client.resumeSession).not.toHaveBeenCalled();
    expect(stoppedSession.send).not.toHaveBeenCalled();
    expect(registry.get(agentId)).toBe(stoppedRecord);
  });
});
