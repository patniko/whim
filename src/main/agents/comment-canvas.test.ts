/**
 * The comment-to-report loop, end to end.
 *
 * The SDK session is stubbed; what is under test is whim's own wiring, which is
 * where this flow breaks in ways nothing else notices: a run that never gets
 * canvases, a report published into the wrong space, two threads quietly
 * sharing one report, or a report that exists but is not linked from the
 * document the user asked from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let createSessionOptions: any = null;

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => os.tmpdir() },
  session: { fromPartition: () => ({ protocol: { handle: vi.fn() }, setPermissionRequestHandler: vi.fn() }) },
}));

vi.mock('../ai', () => ({
  getCopilotClient: () => ({
    createSession: (options: any) => {
      createSessionOptions = options;
      return Promise.resolve({ sessionId: 'session-1', abort: vi.fn(), disconnect: vi.fn() });
    },
  }),
}));

vi.mock('../config', () => ({
  getConfigValue: () => undefined,
}));

vi.mock('./sdk-runner', () => ({
  buildCliToolsPrompt: () => '',
  sendInitialPrompt: () => Promise.resolve(),
  enableRemoteControl: () => Promise.resolve(),
}));

vi.mock('./sandbox-launch', () => ({
  buildSandboxLaunchSetup: () => ({
    isSandboxed: false,
    sandboxConfigs: null,
    mcpServers: {},
    customTools: [],
    sandboxState: null,
    hooks: null,
    enforcementMode: 'both',
    runtimeSandboxConfig: null,
  }),
}));

vi.mock('../cloud-agent', () => ({ getWorkspaceRepo: () => Promise.resolve(null) }));

vi.mock('../database', () => ({ updateCanvasContent: () => ({ titleChanged: false, title: '' }) }));

vi.mock('../canvas-watcher', () => ({ markSelfWrite: vi.fn(), clearSelfWrite: vi.fn() }));

vi.mock('../canvas/artifact-window', () => ({
  openArtifactWindow: vi.fn(),
  reloadArtifactWindow: vi.fn(),
  setArtifactWindowTitle: vi.fn(),
}));

vi.mock('../ipc/typed-handler', () => ({ sendToAllWindows: vi.fn() }));

import { AgentRegistry } from './agent-registry';
import { initCommentWorkflow, launchCommentAgent, handleCommentAgentCompletion } from './comment-workflow';
import { WHIM_REPORT_CANVAS_ID } from '../canvas/sdk-canvas-provider';
import { forgetCanvasEditorContent } from '../services/canvas-editor-state';

const registry = new AgentRegistry();
const replies: any[] = [];

const notifier: any = {
  notifyRenderer: (channel: string, payload: any) => {
    if (channel === 'agent:reply-ready') replies.push(payload);
  },
};
const persistence: any = {
  createAgentSessionRecord: vi.fn(),
  updateSessionId: vi.fn(),
  updateStatus: vi.fn(),
};
const broker: any = {
  createPermissionHandler: () => vi.fn(),
  createPathAwareSandboxPermissionHandler: () => vi.fn(),
  createMxcOnlyPermissionHandler: () => vi.fn(),
  createUserInputHandler: () => vi.fn(),
  createElicitationHandler: () => vi.fn(),
};

initCommentWorkflow({
  registry,
  notifier,
  persistence,
  broker,
  setupAgentEventListeners: vi.fn(),
});

const artifactPersona: any = {
  id: 'default-artifact',
  handle: 'artifact',
  instructions: 'You produce reports.',
  model: '',
  runLocation: 'local',
  canvas: true,
};

const editorPersona: any = {
  id: 'default-editor',
  handle: 'editor',
  instructions: 'You edit documents.',
  model: '',
  runLocation: 'local',
};

let workspace = '';
let spaceDir = '';

/** Stand in for the agent: open the canvas, write a report, publish it. */
async function publishReport(html: string, input: Record<string, unknown> = {}): Promise<any> {
  const canvas: any = createSessionOptions.canvases[0];
  await canvas.open({
    sessionId: 'session-1',
    extensionId: 'whim',
    canvasId: WHIM_REPORT_CANVAS_ID,
    instanceId: 'inst-1',
    input: { title: 'Churn drivers' },
  });
  fs.writeFileSync(path.join(spaceDir, 'report.html'), html, 'utf-8');
  return canvas.actionHandlers.get('publish')({
    sessionId: 'session-1',
    extensionId: 'whim',
    canvasId: WHIM_REPORT_CANVAS_ID,
    instanceId: 'inst-1',
    actionName: 'publish',
    input: { path: 'report.html', title: 'Churn drivers', status: '3 drivers', ...input },
  });
}

function launch(persona: any, spaceId: string, threadId: string | null, documentTarget?: any) {
  return launchCommentAgent(
    spaceId,
    'analyse this',
    'churn is up',
    { prefix: '', suffix: '' },
    persona,
    threadId,
    workspace,
    'space-1',
    documentTarget,
  );
}

function readCanvas(): string {
  return fs.readFileSync(path.join(spaceDir, 'canvas.md'), 'utf-8');
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-comment-canvas-'));
  spaceDir = path.join(workspace, 'space-1');
  fs.mkdirSync(spaceDir, { recursive: true });
  fs.writeFileSync(path.join(spaceDir, 'canvas.md'), '# Notes\n\nchurn is up\n');
  createSessionOptions = null;
  replies.length = 0;
  registry.clear();
  // The editor merge cache is keyed by space id and outlives a test. In the app
  // that is right — one id, one document — but here every test builds a fresh
  // workspace under the same id, so a stale entry would merge one test's
  // document into the next.
  forgetCanvasEditorContent('space-1');
  forgetCanvasEditorContent('__page__space-1/research');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('comment-launched reports', () => {
  it('gives a canvas persona the tools and the obligation to publish', async () => {
    await launch(artifactPersona, 'space-1', 'thread-1');

    expect(createSessionOptions.canvases).toHaveLength(1);
    // Without requestCanvasRenderer the runtime never advertises the tools.
    expect(createSessionOptions.requestCanvasRenderer).toBe(true);
    expect(createSessionOptions.systemMessage.content).toContain('## Report artifact (required)');
  });

  it('leaves ordinary personas exactly as they were', async () => {
    await launch(editorPersona, 'space-1', 'thread-1');

    expect(createSessionOptions.canvases).toBeUndefined();
    expect(createSessionOptions.requestCanvasRenderer).toBeUndefined();
    expect(createSessionOptions.systemMessage.content).not.toContain('## Report artifact (required)');
  });

  it('auto-approves only the canvas tools, since the user named the persona that uses them', async () => {
    const launched = await launch(artifactPersona, 'space-1', 'thread-1') as any;
    const record = registry.get(launched.agentId)!;

    expect(record.autoApproveCanvasTools).toBe(true);
    expect(record.yoloMode).toBeUndefined();
  });

  it('publishes a report and links it into the document the comment was on', async () => {
    await launch(artifactPersona, 'space-1', 'thread-1');
    const result = await publishReport('<p>churn</p>');

    expect(result.ok).toBe(true);
    expect(readCanvas()).toContain(`whim://artifact/space-1/${result.artifactId}`);
    expect(readCanvas()).toContain('Churn drivers');
  });

  it('gives each thread its own report, so a second question cannot overwrite the first', async () => {
    await launch(artifactPersona, 'space-1', 'thread-1');
    const first = await publishReport('<p>one</p>');

    createSessionOptions = null;
    await launch(artifactPersona, 'space-1', 'thread-2');
    const second = await publishReport('<p>two</p>');

    expect(first.artifactId).not.toBe(second.artifactId);
    const canvas = readCanvas();
    expect(canvas).toContain(first.artifactId);
    expect(canvas).toContain(second.artifactId);
    expect(fs.readFileSync(path.join(spaceDir, 'reports', first.artifactId, 'index.html'), 'utf-8'))
      .toContain('one');
  });

  it('refreshes one report when the same thread runs again', async () => {
    await launch(artifactPersona, 'space-1', 'thread-1');
    const first = await publishReport('<p>one</p>');

    createSessionOptions = null;
    await launch(artifactPersona, 'space-1', 'thread-1');
    const second = await publishReport('<p>two</p>');

    expect(second.artifactId).toBe(first.artifactId);
    expect(fs.readdirSync(path.join(spaceDir, 'reports'))).toHaveLength(1);
    // One thread, one link — a rerun must not stack a second copy.
    expect(readCanvas().match(new RegExp(first.artifactId, 'g'))).toHaveLength(1);
  });

  it('ignores an artifact id the model invents, which cannot know about threads', async () => {
    await launch(artifactPersona, 'space-1', 'thread-1');
    const result = await publishReport('<p>churn</p>', { artifactId: 'model-chosen' });

    expect(result.artifactId).not.toBe('model-chosen');
    expect(fs.existsSync(path.join(spaceDir, 'reports', 'model-chosen'))).toBe(false);
  });

  it('stores a child page report against the real space, which is what serves it', async () => {
    fs.writeFileSync(path.join(spaceDir, 'research.md'), '# Research\n\nchurn is up\n');

    await launch(artifactPersona, '__page__space-1/research', 'thread-1', {
      documentPath: path.join(spaceDir, 'research.md'),
      documentDisplayName: 'research.md',
      documentLabel: 'child page document',
    });
    const result = await publishReport('<p>churn</p>');

    expect(result.ok).toBe(true);
    expect(fs.existsSync(path.join(spaceDir, 'reports', result.artifactId, 'index.html'))).toBe(true);
    // The link follows the user to the page they were reading.
    expect(fs.readFileSync(path.join(spaceDir, 'research.md'), 'utf-8'))
      .toContain(`whim://artifact/space-1/${result.artifactId}`);
    expect(readCanvas()).not.toContain('whim://artifact');
  });

  it('replies to the thread with a link, not a summary of work the user cannot see', async () => {
    const launched = await launch(artifactPersona, 'space-1', 'thread-1') as any;
    const result = await publishReport('<p>churn</p>');

    handleCommentAgentCompletion(registry.get(launched.agentId)!);

    const reply = replies.find(r => r.threadId === 'thread-1');
    expect(reply.body).toContain(`whim://artifact/space-1/${result.artifactId}`);
    expect(reply.body).toContain('Churn drivers');
  });

  it('falls back to its ordinary reply when the run published nothing', async () => {
    const launched = await launch(artifactPersona, 'space-1', 'thread-1') as any;
    const record = registry.get(launched.agentId)!;
    record.summary = 'Could not reach the data source.';

    handleCommentAgentCompletion(record);

    expect(replies[0].body).toContain('Could not reach the data source.');
  });
});
