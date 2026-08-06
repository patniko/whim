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

import { createSkillTemplateCanvas } from './skill-canvas-provider';
import { loadSkillCanvasDefinition, type SkillCanvasDefinition } from './skill-canvas-template';
import { getArtifact, listArtifacts } from './artifact-store';
import type { CanvasRunContext } from './sdk-canvas-provider';

let workspace: string;
const FOLDER = 'spaces/open-questions';
const SPACE_ID = 'space-1';
const SKILL_ID = 'look-for-open-questions';

const TEMPLATE = '<h1>{{title}}</h1><ul>{{#items}}<li>{{question}}</li>{{/items}}</ul>';

function spaceDir(): string {
  return path.join(workspace, FOLDER);
}

function run(overrides: Partial<CanvasRunContext> = {}): CanvasRunContext {
  return {
    workspaceRoot: workspace,
    folder: FOLDER,
    spaceId: SPACE_ID,
    skillId: SKILL_ID,
    runId: 'run-1',
    ...overrides,
  };
}

function writeTemplate(template = TEMPLATE): SkillCanvasDefinition {
  const dir = path.join(workspace, '.agents', 'skills', SKILL_ID, 'canvas');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({
    id: 'digest',
    displayName: 'Open questions digest',
    description: 'Questions still waiting on you.',
  }));
  fs.writeFileSync(path.join(dir, 'template.html'), template);
  return loadSkillCanvasDefinition(workspace, SKILL_ID)!;
}

function writeData(relativePath: string, data: unknown): void {
  const target = path.join(spaceDir(), relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof data === 'string' ? data : JSON.stringify(data));
}

function invokeAction(canvas: Canvas, name: string, input: Record<string, unknown>, instanceId = 'inst-1') {
  const handlers = (canvas as unknown as { actionHandlers: Map<string, Function> }).actionHandlers;
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler for action ${name}`);
  return handler({
    sessionId: 'sess-1',
    extensionId: 'whim',
    canvasId: canvas.declaration.id,
    instanceId,
    actionName: name,
    input,
  });
}

function open(canvas: Canvas, input: Record<string, unknown> = {}, instanceId = 'inst-1') {
  return canvas.open({
    sessionId: 'sess-1',
    extensionId: 'whim',
    canvasId: canvas.declaration.id,
    instanceId,
    input,
  } as never);
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-skill-canvas-provider-'));
  fs.mkdirSync(spaceDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('skill template canvas', () => {
  it('declares itself under the skill\'s namespaced id', () => {
    const definition = writeTemplate();

    const canvas = createSkillTemplateCanvas(run(), definition);

    expect(canvas.declaration.id).toBe('skill.look-for-open-questions.digest');
    expect(canvas.declaration.displayName).toBe('Open questions digest');
  });

  it('offers render rather than publish, since the skill supplies the layout', () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    const actions = (canvas.declaration.actions ?? []).map(a => a.name);

    expect(actions).toEqual(['render']);
  });

  it('renders the template from a data file and publishes the result', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    writeData('report.json', { title: 'Open questions', items: [{ question: 'Ship it?' }] });

    await open(canvas, { artifactId: 'digest' });
    const result: any = await invokeAction(canvas, 'render', {
      dataPath: 'report.json',
      artifactId: 'digest',
      title: 'Open questions',
      status: '1 open question',
    });

    expect(result.ok).toBe(true);
    const artifact = getArtifact(workspace, FOLDER, 'digest')!;
    expect(artifact.published).toBe(true);
    expect(artifact.status).toBe('1 open question');
    expect(fs.readFileSync(artifact.htmlPath, 'utf-8'))
      .toBe('<h1>Open questions</h1><ul><li>Ship it?</li></ul>');
  });

  it('escapes findings, so a question containing markup cannot rewrite the report', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    writeData('report.json', { title: 'x', items: [{ question: '<img src=x onerror=alert(1)>' }] });

    await invokeAction(canvas, 'render', { dataPath: 'report.json', artifactId: 'digest' });

    const html = fs.readFileSync(getArtifact(workspace, FOLDER, 'digest')!.htmlPath, 'utf-8');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
  });

  it('keeps the data file alongside the report so the next run can compare', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    writeData('report.json', { title: 'x', items: [] });

    await invokeAction(canvas, 'render', { dataPath: 'report.json', artifactId: 'digest' });

    expect(getArtifact(workspace, FOLDER, 'digest')!.hasData).toBe(true);
  });

  it('reports a missing data file instead of publishing an empty report', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());

    const result: any = await invokeAction(canvas, 'render', { dataPath: 'nope.json', artifactId: 'digest' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('nope.json');
    expect(listArtifacts(workspace, FOLDER).some(a => a.published)).toBe(false);
  });

  it('requires a data path', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());

    const result: any = await invokeAction(canvas, 'render', {});

    expect(result.ok).toBe(false);
  });

  it('rejects data outside the space folder', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    fs.writeFileSync(path.join(workspace, 'secrets.json'), JSON.stringify({ title: 'leak' }));

    const result: any = await invokeAction(canvas, 'render', { dataPath: '../../secrets.json' });

    expect(result.ok).toBe(false);
  });

  it('reports malformed JSON rather than rendering nonsense', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    writeData('report.json', '{not json');

    const result: any = await invokeAction(canvas, 'render', { dataPath: 'report.json' });

    expect(result.ok).toBe(false);
  });

  it('rejects a JSON array, since the template addresses named fields', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    writeData('report.json', [1, 2, 3]);

    const result: any = await invokeAction(canvas, 'render', { dataPath: 'report.json' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON object');
  });

  it('binds without publishing on open, because the runtime reopens on every reconnect', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());

    const first: any = await open(canvas, { artifactId: 'digest' });
    const second: any = await open(canvas, { artifactId: 'digest' });

    expect(first.url).toBe(second.url);
    expect(first.status).toBe('Waiting for content');
    expect(listArtifacts(workspace, FOLDER)).toHaveLength(1);
  });

  it('refreshes the same report when a later run reuses the id', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    writeData('report.json', { title: 'First', items: [] });
    await invokeAction(canvas, 'render', { dataPath: 'report.json', artifactId: 'digest' });

    writeData('report.json', { title: 'Second', items: [] });
    const result: any = await invokeAction(canvas, 'render', { dataPath: 'report.json', artifactId: 'digest' });

    expect(result.changed).toBe(true);
    expect(listArtifacts(workspace, FOLDER)).toHaveLength(1);
    expect(fs.readFileSync(getArtifact(workspace, FOLDER, 'digest')!.htmlPath, 'utf-8')).toContain('Second');
  });

  it('tells the caller when a republish changed nothing', async () => {
    const canvas = createSkillTemplateCanvas(run(), writeTemplate());
    writeData('report.json', { title: 'Same', items: [] });

    await invokeAction(canvas, 'render', { dataPath: 'report.json', artifactId: 'digest' });
    const result: any = await invokeAction(canvas, 'render', { dataPath: 'report.json', artifactId: 'digest' });

    expect(result.changed).toBe(false);
  });

  it('announces a publication so the window and chip can react', async () => {
    const published: string[] = [];
    const canvas = createSkillTemplateCanvas(run(), writeTemplate(), {
      onPublished: (artifact) => { published.push(artifact.artifactId); },
    });
    writeData('report.json', { title: 'x', items: [] });

    await invokeAction(canvas, 'render', { dataPath: 'report.json', artifactId: 'digest' });

    expect(published).toEqual(['digest']);
  });
});
