import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let workspace = '';
const spaces: any[] = [];
const openedWindows: any[] = [];

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: class {},
  app: { getPath: () => os.tmpdir() },
  session: { fromPartition: () => ({ protocol: { handle: vi.fn() }, setPermissionRequestHandler: vi.fn() }) },
}));

vi.mock('../config', () => ({
  getConfigValue: (key: string) => (key === 'workspace' ? workspace : undefined),
}));

vi.mock('../database', () => ({
  getSpace: (id: string) => spaces.find(s => s.id === id) ?? null,
  listSpaces: () => spaces,
}));

vi.mock('../canvas/artifact-window', () => ({
  openArtifactWindow: (opts: any) => { openedWindows.push(opts); return opts; },
}));

import { listSpaceArtifacts, listActiveArtifacts, registerCanvasArtifactHandlers } from './canvas-artifact-handlers';
import { ipcMain } from 'electron';

function addSpace(id: string, status = 'captured'): any {
  const space = { id, folder: id, status };
  fs.mkdirSync(path.join(workspace, id), { recursive: true });
  spaces.push(space);
  return space;
}

function addArtifact(
  spaceId: string,
  artifactId: string,
  overrides: Record<string, unknown> = {},
  publish = true,
): void {
  const dir = path.join(workspace, spaceId, 'reports', artifactId);
  fs.mkdirSync(dir, { recursive: true });
  if (publish) fs.writeFileSync(path.join(dir, 'index.html'), `<h1>${artifactId}</h1>`);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    artifactId,
    spaceId,
    title: artifactId,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...(publish ? { publishedAt: '2024-01-01T00:00:00.000Z' } : {}),
    ...overrides,
  }));
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'whim-artifact-ipc-'));
  spaces.length = 0;
  openedWindows.length = 0;
  vi.mocked(ipcMain.handle).mockClear();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('listSpaceArtifacts', () => {
  it('returns published artifacts with a url on the isolated origin', () => {
    addSpace('space-1');
    addArtifact('space-1', 'open-questions', { status: '3 open questions' });

    const [artifact] = listSpaceArtifacts('space-1');

    expect(artifact).toMatchObject({ artifactId: 'open-questions', status: '3 open questions', published: true });
    expect(artifact.url).toBe('whim-artifact://space/space-1/open-questions/index.html');
  });

  it('hides artifacts that were bound but never published', () => {
    addSpace('space-1');
    addArtifact('space-1', 'open-questions', {}, false);

    expect(listSpaceArtifacts('space-1')).toEqual([]);
  });

  it('returns nothing for an unknown space', () => {
    expect(listSpaceArtifacts('missing')).toEqual([]);
  });

  it('returns nothing when the space folder is gone', () => {
    const space = addSpace('space-1');
    addArtifact('space-1', 'open-questions');
    fs.rmSync(path.join(workspace, space.folder), { recursive: true, force: true });

    expect(listSpaceArtifacts('space-1')).toEqual([]);
  });

  it('lists the most recently published first', () => {
    addSpace('space-1');
    addArtifact('space-1', 'older', { publishedAt: '2024-01-01T00:00:00.000Z' });
    addArtifact('space-1', 'newer', { publishedAt: '2024-06-01T00:00:00.000Z' });

    expect(listSpaceArtifacts('space-1').map(a => a.artifactId)).toEqual(['newer', 'older']);
  });
});

describe('listActiveArtifacts', () => {
  it('spans every space the user has not finished with', () => {
    addSpace('space-1');
    addSpace('space-2');
    addArtifact('space-1', 'questions');
    addArtifact('space-2', 'digest');

    expect(listActiveArtifacts().map(a => a.artifactId).sort()).toEqual(['digest', 'questions']);
  });

  it('drops completed spaces, since closing one is how the user says they are done', () => {
    addSpace('space-1', 'done');
    addArtifact('space-1', 'questions');

    expect(listActiveArtifacts()).toEqual([]);
  });
});

describe('canvas-artifact:open', () => {
  function handlerFor(channel: string): any {
    registerCanvasArtifactHandlers();
    const call = vi.mocked(ipcMain.handle).mock.calls.find(c => c[0] === channel);
    return call?.[1];
  }

  it('opens the artifact window with focus, because the user asked for it', () => {
    addSpace('space-1');
    addArtifact('space-1', 'open-questions');

    const result = handlerFor('canvas-artifact:open')({}, 'space-1', 'open-questions');

    expect(result).toEqual({ ok: true });
    expect(openedWindows[0]).toMatchObject({ spaceId: 'space-1', artifactId: 'open-questions', focus: true });
  });

  it('reports a missing artifact instead of opening an empty window', () => {
    addSpace('space-1');

    const result = handlerFor('canvas-artifact:open')({}, 'space-1', 'gone');

    expect(result).toEqual({ error: 'Report not found' });
    expect(openedWindows).toEqual([]);
  });

  it('will not open an artifact from a space it does not belong to', () => {
    addSpace('space-1');
    addSpace('space-2');
    addArtifact('space-2', 'digest');

    const result = handlerFor('canvas-artifact:open')({}, 'space-1', 'digest');

    expect(result).toEqual({ error: 'Report not found' });
  });
});
