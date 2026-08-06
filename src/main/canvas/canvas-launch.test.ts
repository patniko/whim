import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => os.tmpdir() },
  session: { fromPartition: () => ({ protocol: { handle: vi.fn() }, setPermissionRequestHandler: vi.fn() }) },
}));

const windowCalls: any[] = [];
vi.mock('./artifact-window', () => ({
  openArtifactWindow: (opts: any) => { windowCalls.push({ kind: 'open', ...opts }); return opts; },
  reloadArtifactWindow: (key: any) => { windowCalls.push({ kind: 'reload', ...key }); return true; },
  setArtifactWindowTitle: (key: any, title: string) => { windowCalls.push({ kind: 'title', ...key, title }); },
}));

import { resolveCanvasPolicy, DISABLED_CANVAS_POLICY } from './canvas-policy';
import { resolveRunCanvasConfig } from './canvas-launch';
import { WHIM_REPORT_CANVAS_ID, WHIM_CANVAS_PROVIDER_ID } from './sdk-canvas-provider';

function doc(frontmatter: string, body = 'Do the thing.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

describe('resolveCanvasPolicy', () => {
  it('is disabled when the document has no frontmatter at all', () => {
    expect(resolveCanvasPolicy('just some notes')).toEqual(DISABLED_CANVAS_POLICY);
  });

  it('is disabled by default, so ordinary spaces never gain canvas tools', () => {
    expect(resolveCanvasPolicy(doc('title: Notes')).enabled).toBe(false);
  });

  it('enables the built-in canvas when opted in with a boolean', () => {
    const policy = resolveCanvasPolicy(doc('canvas_artifacts: true'));
    expect(policy.enabled).toBe(true);
    expect(policy.canvasId).toBe(WHIM_REPORT_CANVAS_ID);
  });

  it('honours an explicit opt-out even alongside a skill invocation', () => {
    const policy = resolveCanvasPolicy(doc('canvas_artifacts: false\nskill_invocation:\n  skill_id: s1'));
    expect(policy.enabled).toBe(false);
  });

  it('reads a named canvas type', () => {
    expect(resolveCanvasPolicy(doc('canvas_artifacts: question-board')).canvasId).toBe('question-board');
  });

  it('carries the owning skill through', () => {
    const policy = resolveCanvasPolicy(doc('canvas_artifacts: true\nskill_invocation:\n  skill_id: open-questions'));
    expect(policy.skillId).toBe('open-questions');
  });

  it('marks scheduler-started runs so they can avoid stealing focus', () => {
    const scheduled = resolveCanvasPolicy(
      doc('canvas_artifacts: true\nskill_invocation:\n  skill_id: s1\n  source: schedule'),
    );
    const manual = resolveCanvasPolicy(
      doc('canvas_artifacts: true\nskill_invocation:\n  skill_id: s1\n  source: manual'),
    );
    expect(scheduled.scheduled).toBe(true);
    expect(manual.scheduled).toBe(false);
  });
});

describe('resolveRunCanvasConfig', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    windowCalls.length = 0;
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-canvas-launch-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function makeSpace(folder: string, frontmatter: string): string {
    const dir = path.join(workspaceRoot, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'canvas.md'), doc(frontmatter));
    return dir;
  }

  it('registers the canvas with the renderer request and a stable provider identity', () => {
    const workingDir = makeSpace('space-a', 'canvas_artifacts: true');
    const config = resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: 'space-a', runId: 'run-1' });

    expect(config).not.toBeNull();
    expect(config!.session.canvases).toHaveLength(1);
    // Without requestCanvasRenderer the runtime never advertises canvas tools,
    // so the agent could not open a canvas we registered.
    expect(config!.session.requestCanvasRenderer).toBe(true);
    expect(config!.session.canvasProvider).toEqual({ id: WHIM_CANVAS_PROVIDER_ID, name: 'Whim' });
  });

  it('returns null for the shared workspace session, which no skill owns', () => {
    const workingDir = makeSpace('space-b', 'canvas_artifacts: true');
    expect(resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: '__workspace__' })).toBeNull();
  });

  it('returns null for sessions with no space, such as quick and selection runs', () => {
    const workingDir = makeSpace('space-c', 'canvas_artifacts: true');
    expect(resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: null })).toBeNull();
  });

  it('returns null when the space never opted in', () => {
    const workingDir = makeSpace('space-d', 'title: Notes');
    expect(resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: 'space-d' })).toBeNull();
  });

  it('returns null when the space document is missing', () => {
    const workingDir = path.join(workspaceRoot, 'space-e');
    fs.mkdirSync(workingDir, { recursive: true });
    expect(resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: 'space-e' })).toBeNull();
  });

  it('refuses a working directory outside the workspace', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'canvas.md'), doc('canvas_artifacts: true'));
      expect(resolveRunCanvasConfig({ workspaceRoot, workingDir: outside, spaceId: 'space-f' })).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('falls back to the built-in canvas when a skill names a type that does not exist yet', () => {
    const workingDir = makeSpace('space-g', 'canvas_artifacts: not-a-real-type');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: 'space-g' });
    expect(config).not.toBeNull();
    expect(config!.session.canvases[0].declaration.id).toBe(WHIM_REPORT_CANVAS_ID);
    warn.mockRestore();
  });

  it('shows a published artifact and focuses it for a manual run', async () => {
    const workingDir = makeSpace('space-h', 'canvas_artifacts: true');
    const config = resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: 'space-h', runId: 'run-1' })!;
    const canvas: any = config.session.canvases[0];

    await canvas.open({ sessionId: 's', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID, instanceId: 'i1' });
    fs.writeFileSync(path.join(workingDir, 'out.html'), '<p>hello</p>');
    await (canvas as any).actionHandlers.get('publish')({
      instanceId: 'i1',
      actionName: 'publish',
      input: { path: 'out.html', title: 'Findings' },
    });

    const opened = windowCalls.find(c => c.kind === 'open');
    expect(opened).toMatchObject({ spaceId: 'space-h', focus: true });
  });

  it('opens without focus for a scheduled run, so it cannot interrupt the user', async () => {
    const workingDir = makeSpace('space-i', 'canvas_artifacts: true\nskill_invocation:\n  skill_id: s1\n  source: schedule');
    const config = resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: 'space-i', runId: 'run-2' })!;
    const canvas: any = config.session.canvases[0];

    await canvas.open({ sessionId: 's', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID, instanceId: 'i1' });
    fs.writeFileSync(path.join(workingDir, 'out.html'), '<p>hello</p>');
    await (canvas as any).actionHandlers.get('publish')({
      instanceId: 'i1',
      actionName: 'publish',
      input: { path: 'out.html', title: 'Findings' },
    });

    const opened = windowCalls.find(c => c.kind === 'open');
    expect(opened).toMatchObject({ spaceId: 'space-i', focus: false });
  });

  it('does not open a window merely because a canvas was opened', async () => {
    const workingDir = makeSpace('space-j', 'canvas_artifacts: true');
    const config = resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: 'space-j' })!;
    const canvas: any = config.session.canvases[0];

    await canvas.open({ sessionId: 's', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID, instanceId: 'i1' });

    expect(windowCalls.some(c => c.kind === 'open')).toBe(false);
  });

  it('does not reopen a window when a republish changes nothing', async () => {
    const workingDir = makeSpace('space-k', 'canvas_artifacts: true');
    const config = resolveRunCanvasConfig({ workspaceRoot, workingDir, spaceId: 'space-k' })!;
    const canvas: any = config.session.canvases[0];
    const publish = (canvas as any).actionHandlers.get('publish');

    await canvas.open({ sessionId: 's', extensionId: 'whim', canvasId: WHIM_REPORT_CANVAS_ID, instanceId: 'i1' });
    fs.writeFileSync(path.join(workingDir, 'out.html'), '<p>same</p>');
    await publish({ instanceId: 'i1', actionName: 'publish', input: { path: 'out.html', title: 'Findings' } });
    windowCalls.length = 0;
    await publish({ instanceId: 'i1', actionName: 'publish', input: { path: 'out.html', title: 'Findings' } });

    expect(windowCalls.some(c => c.kind === 'open')).toBe(false);
  });
});
