/**
 * The walking skeleton, end to end: a scheduled skill invocation produces a
 * space whose run publishes an artifact the user can open.
 *
 * The SDK session is stubbed — what is under test is whim's own wiring, which
 * is where the loop actually breaks: a run that never gets canvases, a run that
 * stalls on a permission prompt with nobody watching, or a report that is
 * published but never reaches a window.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let workspace = '';
const spaces: any[] = [];
const skills = new Map<string, any>();
const openedWindows: any[] = [];

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => os.tmpdir() },
  session: { fromPartition: () => ({ protocol: { handle: vi.fn() }, setPermissionRequestHandler: vi.fn() }) },
}));

vi.mock('./config', () => ({
  getConfigValue: (key: string) => (key === 'workspace' ? workspace : undefined),
}));

vi.mock('./database', () => ({
  createSpace: (input: any, skillId?: string) => {
    const space = { id: `space-${spaces.length + 1}`, description: input.body, source_skill_id: skillId, folder: null };
    spaces.push(space);
    return space;
  },
  assignSpaceFolder: (spaceId: string, folder: string) => {
    const space = spaces.find(s => s.id === spaceId);
    if (space) space.folder = folder;
  },
  getSkill: (id: string) => skills.get(id) ?? null,
  updateCanvasContent: vi.fn(),
}));

vi.mock('./workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workspace')>()),
  createSpaceFolder: (root: string, spaceId: string) => {
    fs.mkdirSync(path.join(root, spaceId), { recursive: true });
    return spaceId;
  },
  scheduleAutoCommit: vi.fn(),
}));

vi.mock('./agent-service', () => ({
  launchDocumentAgent: () => Promise.resolve({ agentId: 'agent-1', sessionId: 'session-1' }),
}));

vi.mock('./canvas/artifact-window', () => ({
  openArtifactWindow: (opts: any) => { openedWindows.push(opts); return opts; },
  reloadArtifactWindow: () => true,
  setArtifactWindowTitle: () => {},
  findArtifactWindowByInstance: () => null,
  closeArtifactWindow: () => true,
  onArtifactWindowClosed: () => {},
}));

import { invokeSkill } from './skill-invocation';
import { resolveRunCanvasConfig } from './canvas/canvas-launch';
import { getPrimaryArtifact, listArtifacts } from './canvas/artifact-store';
import { buildArtifactUrl, parseArtifactUrl } from './canvas/artifact-protocol';
import { WHIM_REPORT_CANVAS_ID } from './canvas/sdk-canvas-provider';
import { InteractionBroker } from './agents/interaction-broker';
import type { AgentRecord } from './agents/agent-registry';

function addSkill(id: string, frontmatter: string): void {
  const dir = path.join(workspace, '.agents', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'SKILL.md');
  fs.writeFileSync(filePath, `---\nname: ${id}\ndescription: finds open questions\n${frontmatter}\n---\n\nFind open questions.\n`);
  skills.set(id, { id, name: id, description: 'finds open questions', filePath });
}

/** Stand in for the agent: open the canvas, write a report, publish it. */
async function runAgent(
  canvas: any,
  spaceDir: string,
  html: string,
  input: Record<string, unknown> = {},
): Promise<any> {
  const instanceId = 'inst-1';
  await canvas.open({
    sessionId: 'session-1',
    extensionId: 'whim',
    canvasId: WHIM_REPORT_CANVAS_ID,
    instanceId,
    input: { title: 'Open questions' },
  });
  fs.writeFileSync(path.join(spaceDir, 'report.html'), html, 'utf-8');
  return canvas.actionHandlers.get('publish')({
    sessionId: 'session-1',
    extensionId: 'whim',
    canvasId: WHIM_REPORT_CANVAS_ID,
    instanceId,
    actionName: 'publish',
    input: { path: 'report.html', title: 'Open questions', status: '3 open questions', ...input },
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-canvas-e2e-'));
  spaces.length = 0;
  skills.clear();
  openedWindows.length = 0;
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('scheduled skill to opened artifact', () => {
  it('publishes a report the user can open, without interrupting them', async () => {
    addSkill('open-questions', 'canvas: true');

    const invocation = await invokeSkill({ skillId: 'open-questions', source: 'schedule' }) as any;
    const spaceId = invocation.space.id;
    const spaceDir = path.join(workspace, invocation.space.folder);

    const setup = resolveRunCanvasConfig({
      workspaceRoot: workspace,
      workingDir: spaceDir,
      spaceId,
      agentId: 'agent-1',
    });
    expect(setup).not.toBeNull();

    const result = await runAgent(setup!.session.canvases[0] as any, spaceDir, '<h1>3 open questions</h1>');
    expect(result.ok).toBe(true);

    // The artifact outlives the session because disk is what makes "open it
    // three days later" work.
    const artifact = getPrimaryArtifact(workspace, invocation.space.folder);
    expect(artifact?.published).toBe(true);
    expect(artifact?.status).toBe('3 open questions');
    expect(fs.readFileSync(artifact!.htmlPath, 'utf-8')).toBe('<h1>3 open questions</h1>');

    // Shown, but not in the user's face — this run was unattended.
    expect(openedWindows).toHaveLength(1);
    expect(openedWindows[0]).toMatchObject({ spaceId, focus: false });

    // And the URL the agent got back resolves to that artifact.
    const parsed = parseArtifactUrl(result.url);
    expect(parsed).toMatchObject({ spaceId, artifactId: artifact!.artifactId, file: 'index.html' });
    expect(result.url).toBe(buildArtifactUrl(spaceId, artifact!.artifactId));
  });

  it('refreshes one report across repeat runs instead of stacking new ones', async () => {
    addSkill('open-questions', 'canvas: true');
    const invocation = await invokeSkill({ skillId: 'open-questions', source: 'schedule' }) as any;
    const spaceDir = path.join(workspace, invocation.space.folder);

    const first = resolveRunCanvasConfig({
      workspaceRoot: workspace, workingDir: spaceDir, spaceId: invocation.space.id, agentId: 'agent-1',
    })!;
    await runAgent(first.session.canvases[0] as any, spaceDir, '<h1>3 open questions</h1>');

    // A later occurrence: same space, new session, new canvas object.
    const second = resolveRunCanvasConfig({
      workspaceRoot: workspace, workingDir: spaceDir, spaceId: invocation.space.id, agentId: 'agent-2',
    })!;
    const result = await runAgent(second.session.canvases[0] as any, spaceDir, '<h1>5 open questions</h1>');

    expect(result.changed).toBe(true);
    expect(listArtifacts(workspace, invocation.space.folder)).toHaveLength(1);
    expect(fs.readFileSync(getPrimaryArtifact(workspace, invocation.space.folder)!.htmlPath, 'utf-8'))
      .toBe('<h1>5 open questions</h1>');
  });

  it('lets an unattended run use the canvas tools without waiting for a prompt', async () => {
    const broker = new InteractionBroker(
      { notifyRenderer: vi.fn(), showApprovalNotification: vi.fn() } as any,
      { updateStatus: vi.fn() } as any,
    );
    const record = {
      agentId: 'agent-1', sessionId: 'session-1', spaceId: 'space-1', selectedText: '',
      anchor: { quote: '', prefix: '', suffix: '' }, status: 'running', pendingApprovalId: null,
      pendingPermissionKind: null, pendingApprovals: new Map(), summary: '',
      autoApproveCanvasTools: true,
    } as unknown as AgentRecord;
    const handler = broker.createPermissionHandler(sid => (sid === 'session-1' ? record : undefined));

    const decision = await handler(
      { kind: 'custom-tool', toolName: 'open_canvas', toolCallId: 'req-1' } as any,
      { sessionId: 'session-1' },
    );

    expect(decision).toEqual({ kind: 'approve-once' });
    expect(record.status).toBe('running');
  });
});

describe('runs that produce nothing', () => {
  it('gives a skill that never asked for a canvas none of this machinery', async () => {
    addSkill('plain', '');
    const invocation = await invokeSkill({ skillId: 'plain', source: 'schedule' }) as any;
    const spaceDir = path.join(workspace, invocation.space.folder);

    const setup = resolveRunCanvasConfig({
      workspaceRoot: workspace, workingDir: spaceDir, spaceId: invocation.space.id, agentId: 'agent-1',
    });

    expect(setup).toBeNull();
    expect(listArtifacts(workspace, invocation.space.folder)).toEqual([]);
  });

  it('leaves no artifact and opens no window when a run finishes without publishing', async () => {
    addSkill('open-questions', 'canvas: true');
    const invocation = await invokeSkill({ skillId: 'open-questions', source: 'schedule' }) as any;
    const spaceDir = path.join(workspace, invocation.space.folder);
    const setup = resolveRunCanvasConfig({
      workspaceRoot: workspace, workingDir: spaceDir, spaceId: invocation.space.id, agentId: 'agent-1',
    })!;

    await (setup.session.canvases[0] as any).open({
      sessionId: 'session-1', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID,
      instanceId: 'inst-1', input: { title: 'Open questions' },
    });

    // Opening binds an artifact but publishes nothing, so there is no report to
    // show and nothing to notify about.
    expect(listArtifacts(workspace, invocation.space.folder).map(a => a.published)).toEqual([false]);
    expect(getPrimaryArtifact(workspace, invocation.space.folder)).toBeNull();
    expect(openedWindows).toEqual([]);
  });
});

describe('failed publication', () => {
  it('tells the agent why, rather than letting the run finish as if it worked', async () => {
    addSkill('open-questions', 'canvas: true');
    const invocation = await invokeSkill({ skillId: 'open-questions', source: 'schedule' }) as any;
    const spaceDir = path.join(workspace, invocation.space.folder);
    const setup = resolveRunCanvasConfig({
      workspaceRoot: workspace, workingDir: spaceDir, spaceId: invocation.space.id, agentId: 'agent-1',
    })!;
    const canvas: any = setup.session.canvases[0];

    await canvas.open({
      sessionId: 'session-1', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID,
      instanceId: 'inst-1', input: { title: 'Open questions' },
    });
    const result = await canvas.actionHandlers.get('publish')({
      sessionId: 'session-1', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID,
      instanceId: 'inst-1', actionName: 'publish',
      input: { path: 'never-written.html', title: 'Open questions' },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(openedWindows).toEqual([]);
  });

  it('refuses to publish a file from outside the space', async () => {
    addSkill('open-questions', 'canvas: true');
    const invocation = await invokeSkill({ skillId: 'open-questions', source: 'schedule' }) as any;
    const spaceDir = path.join(workspace, invocation.space.folder);
    fs.writeFileSync(path.join(workspace, 'secret.html'), '<p>not yours</p>', 'utf-8');

    const setup = resolveRunCanvasConfig({
      workspaceRoot: workspace, workingDir: spaceDir, spaceId: invocation.space.id, agentId: 'agent-1',
    })!;
    const canvas: any = setup.session.canvases[0];

    await canvas.open({
      sessionId: 'session-1', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID,
      instanceId: 'inst-1', input: { title: 'Open questions' },
    });
    const result = await canvas.actionHandlers.get('publish')({
      sessionId: 'session-1', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID,
      instanceId: 'inst-1', actionName: 'publish',
      input: { path: '../secret.html', title: 'Open questions' },
    });

    expect(result.ok).toBe(false);
    expect(getPrimaryArtifact(workspace, invocation.space.folder)).toBeNull();
  });
});
