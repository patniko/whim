import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Canvas } from '@github/copilot-sdk';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn() } })) },
}));

import { createArtifactCanvas, WHIM_REPORT_CANVAS_ID, type CanvasRunContext } from './sdk-canvas-provider';
import { getArtifact, listArtifacts } from './artifact-store';

let workspace: string;
const FOLDER = 'spaces/open-questions';
const SPACE_ID = 'space-1';

function spaceDir(): string {
  return path.join(workspace, FOLDER);
}

function run(overrides: Partial<CanvasRunContext> = {}): CanvasRunContext {
  return { workspaceRoot: workspace, folder: FOLDER, spaceId: SPACE_ID, runId: 'run-1', ...overrides };
}

/** Action handlers are internal to the SDK's Canvas; reach them the way the runtime does. */
function invokeAction(canvas: Canvas, name: string, input: Record<string, unknown>, instanceId = 'inst-1') {
  const handlers = (canvas as unknown as { actionHandlers: Map<string, Function> }).actionHandlers;
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler for action ${name}`);
  return handler({
    sessionId: 'sess-1',
    extensionId: 'whim',
    canvasId: WHIM_REPORT_CANVAS_ID,
    instanceId,
    actionName: name,
    input,
  });
}

function open(canvas: Canvas, input: Record<string, unknown> = {}, instanceId = 'inst-1') {
  return canvas.open({
    sessionId: 'sess-1',
    extensionId: 'whim',
    canvasId: WHIM_REPORT_CANVAS_ID,
    instanceId,
    input,
  });
}

function writeReport(name: string, html: string): void {
  const full = path.join(spaceDir(), name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, html, 'utf-8');
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-canvas-'));
  fs.mkdirSync(spaceDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('declaration', () => {
  it('declares the canvas and its actions to the runtime', () => {
    const canvas = createArtifactCanvas(run());
    expect(canvas.declaration.id).toBe(WHIM_REPORT_CANVAS_ID);
    expect(canvas.declaration.actions?.map(a => a.name).sort()).toEqual(['publish', 'set_status']);
  });

  it('does not expose a space or workspace field the model could set', () => {
    const canvas = createArtifactCanvas(run());
    const openProps = Object.keys((canvas.declaration.inputSchema as any).properties);
    const publishProps = Object.keys(
      (canvas.declaration.actions!.find(a => a.name === 'publish')!.inputSchema as any).properties,
    );

    expect(openProps).not.toContain('spaceId');
    expect(publishProps).not.toContain('spaceId');
    expect(publishProps).not.toContain('workspaceRoot');
  });
});

describe('open', () => {
  it('binds an artifact without publishing', async () => {
    const canvas = createArtifactCanvas(run());
    const result = await open(canvas, { title: 'Open questions' });

    expect(result.status).toBe('Waiting for content');
    expect(getArtifact(workspace, FOLDER, 'open-questions')?.published).toBe(false);
  });

  it('is idempotent across reconnects and never republishes', async () => {
    const onPublished = vi.fn();
    const canvas = createArtifactCanvas(run(), { onPublished });

    await open(canvas, { title: 'Open questions' });
    writeReport('report.html', '<h1>First</h1>');
    await invokeAction(canvas, 'publish', { path: 'report.html', artifactId: 'open-questions' });
    onPublished.mockClear();

    // The runtime re-issues canvas.open whenever the provider reconnects.
    const reopened = await open(canvas, { title: 'Open questions' });

    expect(onPublished).not.toHaveBeenCalled();
    expect(reopened.status).not.toBe('Waiting for content');
    expect(fs.readFileSync(getArtifact(workspace, FOLDER, 'open-questions')!.htmlPath, 'utf-8')).toBe(
      '<h1>First</h1>',
    );
    expect(listArtifacts(workspace, FOLDER)).toHaveLength(1);
  });

  it('derives a stable artifact id from the title', async () => {
    const canvas = createArtifactCanvas(run());
    await open(canvas, { title: 'Open Questions!' });
    expect(getArtifact(workspace, FOLDER, 'open-questions')).not.toBeNull();
  });

  it('falls back to a default id when nothing usable is supplied', async () => {
    const canvas = createArtifactCanvas(run());
    await open(canvas, {});
    expect(getArtifact(workspace, FOLDER, 'report')).not.toBeNull();
  });

  it('notifies the host that an instance was bound', async () => {
    const onBound = vi.fn();
    const canvas = createArtifactCanvas(run(), { onBound });
    await open(canvas, { title: 'Open questions' }, 'inst-9');

    expect(onBound).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'open-questions' }),
      expect.objectContaining({ instanceId: 'inst-9' }),
    );
  });
});

describe('publish', () => {
  it('imports the agent-written file and reports the artifact back', async () => {
    const onPublished = vi.fn();
    const canvas = createArtifactCanvas(run({ skillId: 'skill-1' }), { onPublished });
    await open(canvas, { title: 'Open questions' });
    writeReport('out/report.html', '<h1>7 questions</h1>');

    const result: any = await invokeAction(canvas, 'publish', {
      path: 'out/report.html',
      artifactId: 'open-questions',
      status: '7 open questions',
    });

    expect(result.ok).toBe(true);
    expect(result.artifactId).toBe('open-questions');
    expect(result.changed).toBe(true);

    const artifact = getArtifact(workspace, FOLDER, 'open-questions')!;
    expect(artifact.published).toBe(true);
    expect(artifact.status).toBe('7 open questions');
    expect(artifact.runId).toBe('run-1');
    expect(artifact.skillId).toBe('skill-1');
    expect(onPublished).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: 'open-questions' }),
      expect.objectContaining({ changed: true }),
    );
  });

  it('reports changed=false when a refresh produces identical content', async () => {
    const canvas = createArtifactCanvas(run());
    writeReport('report.html', '<h1>Same</h1>');
    await invokeAction(canvas, 'publish', { path: 'report.html' });
    const second: any = await invokeAction(canvas, 'publish', { path: 'report.html' });
    expect(second.changed).toBe(false);
  });

  it('surfaces a missing file as an error instead of silently succeeding', async () => {
    const canvas = createArtifactCanvas(run());
    const result: any = await invokeAction(canvas, 'publish', { path: 'nope.html' });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/source_missing/);
  });

  it('requires a path', async () => {
    const canvas = createArtifactCanvas(run());
    const result: any = await invokeAction(canvas, 'publish', {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/path/);
  });

  it('refuses a path outside the run space', async () => {
    fs.writeFileSync(path.join(workspace, 'secret.html'), 'secret', 'utf-8');
    const canvas = createArtifactCanvas(run());

    const result: any = await invokeAction(canvas, 'publish', { path: '../secret.html' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/path_escape/);
  });

  it('cannot write into another run space even with a crafted artifact id', async () => {
    const otherFolder = 'spaces/other';
    fs.mkdirSync(path.join(workspace, otherFolder), { recursive: true });
    const canvas = createArtifactCanvas(run());
    writeReport('report.html', '<h1>Mine</h1>');

    const result = await invokeAction(canvas, 'publish', { path: 'report.html', artifactId: '../../other/hijack' });

    // Rejected outright rather than quietly slugified into a different report.
    expect(result).toMatchObject({ ok: false });
    expect(listArtifacts(workspace, otherFolder)).toHaveLength(0);
    expect(listArtifacts(workspace, FOLDER)).toHaveLength(0);
  });

  it('rejects an explicit artifact id that is not already a safe id', async () => {
    const canvas = createArtifactCanvas(run());
    writeReport('report.html', '<h1>A</h1>');

    // "Q&A" and "Q A" both slugify to "q-a", so honouring them silently would
    // let one report replace an unrelated one.
    const result = await invokeAction(canvas, 'publish', { path: 'report.html', artifactId: 'Q&A' });

    expect(result).toMatchObject({ ok: false });
    expect(String((result as any).error)).toMatch(/lowercase letters, digits and hyphens/);
    expect(listArtifacts(workspace, FOLDER)).toHaveLength(0);
  });

  it('still derives an id from a title, which has no such expectation', async () => {
    const canvas = createArtifactCanvas(run());
    writeReport('report.html', '<h1>A</h1>');

    const result = await invokeAction(canvas, 'publish', { path: 'report.html', title: 'Q&A digest' });

    expect(result).toMatchObject({ ok: true, artifactId: 'q-a-digest' });
  });

  it('verifies a supplied content hash', async () => {
    const canvas = createArtifactCanvas(run());
    writeReport('report.html', '<h1>Report</h1>');

    const result: any = await invokeAction(canvas, 'publish', { path: 'report.html', contentHash: 'deadbeef' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/hash_mismatch/);
  });

  it('imports an optional data payload', async () => {
    const canvas = createArtifactCanvas(run());
    writeReport('report.html', '<h1>Report</h1>');
    writeReport('data.json', JSON.stringify({ count: 3 }));

    await invokeAction(canvas, 'publish', { path: 'report.html', dataPath: 'data.json' });
    expect(getArtifact(workspace, FOLDER, 'report')?.hasData).toBe(true);
  });
});

describe('set_status and close', () => {
  it('updates status without touching content', async () => {
    const onStatusChanged = vi.fn();
    const canvas = createArtifactCanvas(run(), { onStatusChanged });
    writeReport('report.html', '<h1>Report</h1>');
    await invokeAction(canvas, 'publish', { path: 'report.html' });

    const result: any = await invokeAction(canvas, 'set_status', { status: 'Refreshed' });

    expect(result.ok).toBe(true);
    expect(getArtifact(workspace, FOLDER, 'report')?.status).toBe('Refreshed');
    expect(fs.readFileSync(getArtifact(workspace, FOLDER, 'report')!.htmlPath, 'utf-8')).toBe('<h1>Report</h1>');
    expect(onStatusChanged).toHaveBeenCalled();
  });

  it('errors when the report does not exist yet', async () => {
    const canvas = createArtifactCanvas(run());
    const result: any = await invokeAction(canvas, 'set_status', { status: 'x', artifactId: 'ghost' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ghost/);
  });

  it('reports closes to the host', async () => {
    const onClosed = vi.fn();
    const canvas = createArtifactCanvas(run(), { onClosed });

    canvas.onClose?.({
      sessionId: 'sess-1',
      extensionId: 'whim',
      canvasId: WHIM_REPORT_CANVAS_ID,
      instanceId: 'inst-1',
    });

    expect(onClosed).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'inst-1' }));
  });
});
