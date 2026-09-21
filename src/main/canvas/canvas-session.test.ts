import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Canvas, CanvasAction } from '@github/copilot-sdk';

vi.mock('../notify', () => ({ notifyAllWindows: vi.fn() }));
vi.mock('../canvas-watcher', () => ({ markSelfWrite: vi.fn(), clearSelfWrite: vi.fn() }));
vi.mock('../storage', async () => {
  const artifacts = await import('./artifact-store');
  const documents = await import('../storage-documents');
  return {
    ...artifacts,
    acknowledgeArtifactPublication: vi.fn(artifacts.acknowledgeArtifactPublication),
    publishArtifact: vi.fn(artifacts.publishArtifact),
    readCanvas: (await import('../workspace')).readCanvas,
    readDocument: documents.readDocument,
    documentMatches: documents.documentMatches,
    writeDocument: vi.fn((input: import('../storage-documents').DocumentWrite) =>
      documents.writeDocument({ ...input, spaceId: undefined })),
  };
});
vi.mock('../services/canvas-editor-state', async importOriginal => {
  const editor = await importOriginal<typeof import('../services/canvas-editor-state')>();
  return {
    ...editor,
    writeMainCanvasWithMergeAsync: vi.fn(editor.writeMainCanvasWithMergeAsync),
  };
});

import { acknowledgeArtifactPublication, publishArtifact, writeDocument } from '../storage';
import { writeMainCanvasWithMergeAsync } from '../services/canvas-editor-state';
import { getArtifact, CanvasArtifactError } from './artifact-store';
import { buildCanvasSessionConfig, type CanvasSessionHooks } from './canvas-session';
import { linkArtifactIntoDocument, upsertArtifactLink } from './artifact-linkback';
import { WHIM_REPORT_CANVAS_ID, type CanvasRunContext } from './sdk-canvas-provider';

let workspace: string;
const folder = 'spaces/digest';
const spaceId = 'digest-space';
const artifactId = 'comment-thread';
const link = { spaceId, artifactId, title: 'Digest' };
const initial = '# Notes\n\nKeep my writing.\n';

function dispatch(canvas: Canvas, actionName: string, input: Record<string, string>): Promise<unknown> {
  const handlers = (canvas as Canvas & { actionHandlers: Map<string, CanvasAction['handler']> }).actionHandlers;
  const handler = handlers.get(actionName);
  if (!handler) throw new Error(`Missing canvas action: ${actionName}`);
  return Promise.resolve(handler({
    sessionId: 'session', extensionId: 'whim', canvasId: canvas.declaration.id,
    instanceId: 'instance', actionName, input,
  }));
}

function setup(template: boolean, hooks: CanvasSessionHooks) {
  const run: CanvasRunContext = {
    workspaceRoot: workspace, folder, spaceId, runId: 'run', pinnedArtifactId: artifactId,
    ...(template ? { skillId: 'digest' } : {}),
  };
  return buildCanvasSessionConfig(run, {
    enabled: true, scheduled: false, canvasId: template ? 'digest' : WHIM_REPORT_CANVAS_ID,
  }, hooks)!.config.canvases[0];
}

function publish(canvas: Canvas, template: boolean): Promise<unknown> {
  return dispatch(canvas, template ? 'render' : 'publish', {
    ...(template ? { dataPath: 'report.json' } : { path: 'report.html' }), title: link.title,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-canvas-delivery-'));
  const space = path.join(workspace, folder);
  fs.mkdirSync(space, { recursive: true });
  fs.writeFileSync(path.join(space, 'canvas.md'), initial);
  fs.writeFileSync(path.join(space, 'report.html'), '<h1>Digest</h1>');
  fs.writeFileSync(path.join(space, 'report.json'), JSON.stringify({ title: 'Digest' }));
  const template = path.join(workspace, '.agents/skills/digest/canvas');
  fs.mkdirSync(template, { recursive: true });
  fs.writeFileSync(path.join(template, 'canvas.json'), JSON.stringify({ id: 'digest', displayName: 'Digest' }));
  fs.writeFileSync(path.join(template, 'template.html'), '<h1>{{title}}</h1>');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe.each([false, true])('publication delivery (template=%s)', template => {
  it.each([false, true])('retries merge_busy on identical content (new session=%s)', async newSession => {
    const deliver = vi.fn(async () => {
      await linkArtifactIntoDocument({ workspaceRoot: workspace, folder, spaceId, link });
    });
    const changed = vi.fn();
    const hooks = { onArtifactPublished: deliver, onArtifactChanged: changed };
    const first = setup(template, hooks);
    vi.mocked(writeMainCanvasWithMergeAsync).mockResolvedValueOnce({ success: false, error: 'merge_busy' });

    expect(await publish(first, template)).toEqual({ ok: false, error: 'merge_busy' });
    const pending = getArtifact(workspace, folder, artifactId)!;
    expect(pending.published).toBe(true);
    expect(pending.pendingPublicationId).toEqual(expect.any(String));
    expect(fs.readFileSync(path.join(workspace, folder, 'canvas.md'), 'utf8')).toBe(initial);
    expect(acknowledgeArtifactPublication).not.toHaveBeenCalled();

    const edited = `${initial}\nA thought while the report was being saved.\n`;
    fs.writeFileSync(path.join(workspace, folder, 'canvas.md'), edited);
    const retry = newSession ? setup(template, hooks) : first;
    await retry.open({
      sessionId: 'resumed-session', extensionId: 'whim', canvasId: retry.declaration.id,
      instanceId: 'resumed-instance', input: {},
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await publish(retry, template)).toEqual({ ok: true, artifactId, changed: false });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(workspace, folder, 'canvas.md'), 'utf8')).toBe(upsertArtifactLink(edited, link));
    expect(getArtifact(workspace, folder, artifactId)?.pendingPublicationId).toBeUndefined();
    expect(writeDocument).toHaveBeenCalledTimes(1);

    // Already-delivered identical publication keeps its original no-op semantics.
    expect(await publish(setup(template, hooks), template)).toEqual({ ok: true, artifactId, changed: false });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(writeDocument).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it('retries an unacknowledged delivery without rewriting or duplicating an existing link', async () => {
    const deliver = vi.fn(async () => {
      await linkArtifactIntoDocument({ workspaceRoot: workspace, folder, spaceId, link });
    });
    vi.mocked(acknowledgeArtifactPublication).mockRejectedValueOnce(new Error('Acknowledgement write failed'));
    const canvas = setup(template, { onArtifactPublished: deliver });
    expect(await publish(canvas, template)).toEqual({ ok: false, error: 'Acknowledgement write failed' });
    expect(await publish(setup(template, { onArtifactPublished: deliver }), template))
      .toEqual({ ok: true, artifactId, changed: false });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(writeMainCanvasWithMergeAsync).toHaveBeenCalledTimes(1);
    expect(writeDocument).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(workspace, folder, 'canvas.md'), 'utf8')).toBe(upsertArtifactLink(initial, link));
  });

  it('does not deliver a publication whose artifact write failed', async () => {
    const deliver = vi.fn();
    vi.mocked(publishArtifact).mockRejectedValueOnce(new CanvasArtifactError('write_failed', 'Artifact write failed'));
    const canvas = setup(template, { onArtifactPublished: deliver });
    expect(await publish(canvas, template)).toMatchObject({ ok: false, error: expect.stringContaining('Artifact write failed') });
    expect(deliver).not.toHaveBeenCalled();
    expect(acknowledgeArtifactPublication).not.toHaveBeenCalled();
    expect(getArtifact(workspace, folder, artifactId)).toBeNull();
    expect(fs.readFileSync(path.join(workspace, folder, 'canvas.md'), 'utf8')).toBe(initial);
  });

  it('serializes identical concurrent deliveries across canvas sessions', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const delivering = new Promise<void>(resolve => { started = resolve; });
    const deliver = vi.fn(async () => {
      started();
      await blocked;
      await linkArtifactIntoDocument({ workspaceRoot: workspace, folder, spaceId, link });
    });
    const first = publish(setup(template, { onArtifactPublished: deliver }), template);
    await delivering;
    const second = publish(setup(template, { onArtifactPublished: deliver }), template);
    release();
    expect(await first).toEqual({ ok: true, artifactId, changed: true });
    expect(await second).toEqual({ ok: true, artifactId, changed: false });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(writeDocument).toHaveBeenCalledTimes(1);
  });
});
