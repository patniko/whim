/**
 * Regression: no private URL scheme may cross the SDK RPC boundary.
 *
 * The Copilot runtime validates the `url` a canvas provider returns from `open`
 * against the schemes it knows how to render, and rejects anything else — which
 * fails the whole open, so `publish` never runs and the agent writes a report
 * that is never attached to anything. `whim-artifact://` is a private Electron
 * scheme and must stay on whim's side of the boundary.
 *
 * These tests are written against the rule rather than the current field shape:
 * whatever an open result grows to carry, no value in it may name a scheme the
 * runtime cannot render.
 */
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

import { createArtifactCanvas, type CanvasRunContext } from './sdk-canvas-provider';
import { createSkillTemplateCanvas } from './skill-canvas-provider';
import { loadSkillCanvasDefinition, type SkillCanvasDefinition } from './skill-canvas-template';
import { ARTIFACT_SCHEME } from './artifact-protocol';

let workspace: string;
const FOLDER = 'spaces/open-questions';
const SPACE_ID = 'space-1';
const SKILL_ID = 'look-for-open-questions';

/** Schemes a web renderer can be expected to load. Anything else is a bug. */
const RENDERABLE_SCHEMES = ['http:', 'https:'];

function run(): CanvasRunContext {
  return { workspaceRoot: workspace, folder: FOLDER, spaceId: SPACE_ID, skillId: SKILL_ID, runId: 'run-1' };
}

function writeTemplate(): SkillCanvasDefinition {
  const dir = path.join(workspace, '.agents', 'skills', SKILL_ID, 'canvas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({
    id: 'digest',
    displayName: 'Open questions digest',
    description: 'Questions still waiting on you.',
  }));
  fs.writeFileSync(path.join(dir, 'template.html'), '<h1>{{title}}</h1>');
  return loadSkillCanvasDefinition(workspace, SKILL_ID)!;
}

function open(canvas: Canvas, input: Record<string, unknown> = {}) {
  return canvas.open({
    sessionId: 'sess-1',
    extensionId: 'whim',
    canvasId: canvas.declaration.id,
    instanceId: 'inst-1',
    input,
  } as never);
}

/** Every string the result carries, so a renamed or added field is still covered. */
function stringValues(result: unknown): string[] {
  return Object.values((result ?? {}) as Record<string, unknown>).filter(
    (value): value is string => typeof value === 'string',
  );
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-open-url-'));
  fs.mkdirSync(path.join(workspace, FOLDER), { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe.each([
  ['report canvas', () => createArtifactCanvas(run())],
  ['skill template canvas', () => createSkillTemplateCanvas(run(), writeTemplate())],
])('%s open result', (_name, build) => {
  it('names no scheme the runtime cannot render', async () => {
    const result = await open(build(), { title: 'Open questions' });

    for (const value of stringValues(result)) {
      const scheme = /^([a-z][a-z0-9+.-]*:)\/\//i.exec(value)?.[1];
      if (!scheme) continue;
      expect(RENDERABLE_SCHEMES).toContain(scheme.toLowerCase());
    }
  });

  it('does not leak the private artifact scheme', async () => {
    const result = await open(build(), { title: 'Open questions' });

    expect(JSON.stringify(result)).not.toContain(`${ARTIFACT_SCHEME}:`);
  });

  it('still tells the host what was bound', async () => {
    // The point is to withhold the URL, not to return nothing: the title and
    // status are what the runtime shows for a canvas it does not render itself.
    const result = await open(build(), { title: 'Open questions' }) as Record<string, unknown>;

    expect(result.title).toBeTruthy();
    expect(result.status).toBe('Waiting for content');
  });
});
