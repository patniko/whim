import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  bindArtifact,
  publishArtifact,
  setArtifactStatus,
  getArtifact,
  listArtifacts,
  getPrimaryArtifact,
  findArtifactByInstance,
  deleteArtifact,
  resolveArtifactDir,
  resolveInsideSpace,
  isValidArtifactId,
  toArtifactId,
  hashContent,
  readManifest,
  CanvasArtifactError,
  MAX_ARTIFACT_BYTES,
  ARTIFACT_FILE,
  writeArtifactFile,
} from './artifact-store';

let workspace: string;
const FOLDER = 'spaces/open-questions';
const SPACE_ID = 'space-1';

function spaceDir(): string {
  return path.join(workspace, FOLDER);
}

function writeSourceFile(relativePath: string, content: string): void {
  const full = path.join(spaceDir(), relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf-8');
}

async function publishHtml(html: string, overrides: Record<string, unknown> = {}) {
  writeSourceFile('report.html', html);
  return publishArtifact({
    workspaceRoot: workspace,
    folder: FOLDER,
    spaceId: SPACE_ID,
    artifactId: 'open-questions',
    title: 'Open questions',
    sourceRelativePath: 'report.html',
    ...overrides,
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-'));
  fs.mkdirSync(spaceDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('artifact id validation', () => {
  it('accepts lowercase slugs and rejects anything that could escape', () => {
    expect(isValidArtifactId('open-questions')).toBe(true);
    expect(isValidArtifactId('report_2')).toBe(true);

    expect(isValidArtifactId('..')).toBe(false);
    expect(isValidArtifactId('../escape')).toBe(false);
    expect(isValidArtifactId('a/b')).toBe(false);
    expect(isValidArtifactId('Upper')).toBe(false);
    expect(isValidArtifactId('-leading')).toBe(false);
    expect(isValidArtifactId('')).toBe(false);
  });

  it('derives ids from free text and falls back when nothing survives', () => {
    expect(toArtifactId('Open Questions!')).toBe('open-questions');
    expect(toArtifactId('   ')).toBe('report');
    expect(toArtifactId('!!!', 'fallback')).toBe('fallback');
  });

  it('refuses to resolve a directory for an invalid id', () => {
    expect(() => resolveArtifactDir(workspace, FOLDER, '../../etc')).toThrow(CanvasArtifactError);
  });
});

describe('resolveInsideSpace', () => {
  it('resolves a normal relative path inside the space', () => {
    const resolved = resolveInsideSpace(workspace, FOLDER, 'out/report.html');
    expect(resolved).toBe(path.join(spaceDir(), 'out', 'report.html'));
  });

  it('rejects absolute paths and parent traversal', () => {
    expect(() => resolveInsideSpace(workspace, FOLDER, '/etc/passwd')).toThrow(/relative/);
    expect(() => resolveInsideSpace(workspace, FOLDER, '../../secrets.txt')).toThrow(/outside/);
    expect(() => resolveInsideSpace(workspace, FOLDER, '')).toThrow(CanvasArtifactError);
  });

  it('rejects a symlink that points outside the space', () => {
    const outside = path.join(workspace, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.html'), 'secret', 'utf-8');
    fs.symlinkSync(path.join(outside, 'secret.html'), path.join(spaceDir(), 'link.html'));

    expect(() => resolveInsideSpace(workspace, FOLDER, 'link.html')).toThrow(/outside/);
  });
});

describe('bindArtifact', () => {
  it('creates a manifest without publishing content', async () => {
    const artifact = await bindArtifact({
      workspaceRoot: workspace,
      folder: FOLDER,
      spaceId: SPACE_ID,
      artifactId: 'open-questions',
      title: 'Open questions',
      instanceId: 'inst-1',
      canvasId: 'whim-report',
    });

    expect(artifact.published).toBe(false);
    expect(artifact.instanceId).toBe('inst-1');
    expect(artifact.publishedAt).toBeUndefined();
    expect(fs.existsSync(path.join(artifact.dir, 'manifest.json'))).toBe(true);
  });

  it('is idempotent across repeated opens and never clobbers published content', async () => {
    await bindArtifact({
      workspaceRoot: workspace,
      folder: FOLDER,
      spaceId: SPACE_ID,
      artifactId: 'open-questions',
      title: 'Open questions',
      instanceId: 'inst-1',
    });
    await publishHtml('<p>first</p>');

    // The runtime re-issues canvas.open on every provider reconnect.
    const rebound = await bindArtifact({
      workspaceRoot: workspace,
      folder: FOLDER,
      spaceId: SPACE_ID,
      artifactId: 'open-questions',
      title: 'Open questions',
      instanceId: 'inst-1',
    });

    expect(rebound.published).toBe(true);
    expect(rebound.publishedAt).toBeTruthy();
    expect(fs.readFileSync(rebound.htmlPath, 'utf-8')).toBe('<p>first</p>');
  });
});

describe('publishArtifact', () => {
  it('imports an agent-written file and records its hash', async () => {
    const { artifact, changed } = await publishHtml('<h1>Report</h1>');

    expect(changed).toBe(true);
    expect(artifact.published).toBe(true);
    expect(artifact.contentHash).toBe(hashContent('<h1>Report</h1>'));
    expect(artifact.contentBytes).toBe(Buffer.byteLength('<h1>Report</h1>'));
    expect(fs.readFileSync(path.join(artifact.dir, ARTIFACT_FILE), 'utf-8')).toBe('<h1>Report</h1>');
  });

  it('reports changed=false when republishing identical bytes', async () => {
    await publishHtml('<h1>Same</h1>');
    const second = await publishHtml('<h1>Same</h1>');
    expect(second.changed).toBe(false);
  });

  it('replaces content on a refresh run and keeps the creation timestamp', async () => {
    const first = await publishHtml('<h1>Old</h1>');
    const second = await publishHtml('<h1>New</h1>', { runId: 'run-2' });

    expect(second.changed).toBe(true);
    expect(second.artifact.createdAt).toBe(first.artifact.createdAt);
    expect(second.artifact.runId).toBe('run-2');
    expect(fs.readFileSync(second.artifact.htmlPath, 'utf-8')).toBe('<h1>New</h1>');
  });

  it('verifies a supplied content hash', async () => {
    await expect(publishHtml('<h1>Report</h1>', { contentHash: 'deadbeef' })).rejects.toThrow(/hash/);
  });

  it('rejects a missing source file', async () => {
    await expect(
      publishArtifact({
        workspaceRoot: workspace,
        folder: FOLDER,
        spaceId: SPACE_ID,
        artifactId: 'open-questions',
        title: 'Open questions',
        sourceRelativePath: 'nope.html',
      }),
    ).rejects.toThrow(/No artifact file/);
  });

  it('rejects a source path outside the space', async () => {
    fs.writeFileSync(path.join(workspace, 'secret.html'), 'secret', 'utf-8');
    await expect(
      publishArtifact({
        workspaceRoot: workspace,
        folder: FOLDER,
        spaceId: SPACE_ID,
        artifactId: 'open-questions',
        title: 'Open questions',
        sourceRelativePath: '../secret.html',
      }),
    ).rejects.toThrow(/outside/);
  });

  it('rejects oversized artifacts', async () => {
    await expect(publishHtml('x'.repeat(MAX_ARTIFACT_BYTES + 1))).rejects.toThrow(/over the/);
  });

  it('does not truncate the source when the agent writes straight into the artifact dir', async () => {
    const dir = resolveArtifactDir(workspace, FOLDER, 'open-questions');
    fs.mkdirSync(dir, { recursive: true });
    const relative = path.relative(spaceDir(), path.join(dir, ARTIFACT_FILE));
    fs.writeFileSync(path.join(dir, ARTIFACT_FILE), '<h1>In place</h1>', 'utf-8');

    const { artifact } = await publishArtifact({
      workspaceRoot: workspace,
      folder: FOLDER,
      spaceId: SPACE_ID,
      artifactId: 'open-questions',
      title: 'Open questions',
      sourceRelativePath: relative,
    });

    expect(fs.readFileSync(artifact.htmlPath, 'utf-8')).toBe('<h1>In place</h1>');
  });

  it('imports an optional structured payload', async () => {
    writeSourceFile('data.json', JSON.stringify({ questions: 3 }));
    const { artifact } = await publishHtml('<h1>Report</h1>', { dataRelativePath: 'data.json' });

    expect(artifact.hasData).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(artifact.dir, 'data.json'), 'utf-8'))).toEqual({ questions: 3 });
  });

  it('serializes concurrent publishes to the same artifact', async () => {
    writeSourceFile('a.html', '<p>a</p>');
    writeSourceFile('b.html', '<p>b</p>');

    const results = await Promise.all([
      publishArtifact({
        workspaceRoot: workspace,
        folder: FOLDER,
        spaceId: SPACE_ID,
        artifactId: 'open-questions',
        title: 'A',
        runId: 'run-a',
        sourceRelativePath: 'a.html',
      }),
      publishArtifact({
        workspaceRoot: workspace,
        folder: FOLDER,
        spaceId: SPACE_ID,
        artifactId: 'open-questions',
        title: 'B',
        runId: 'run-b',
        sourceRelativePath: 'b.html',
      }),
    ]);

    const manifest = readManifest(results[0].artifact.dir)!;
    const html = fs.readFileSync(results[0].artifact.htmlPath, 'utf-8');
    // Whichever ran last must have written both the file and the manifest —
    // they cannot come from different publishes.
    expect(manifest.contentHash).toBe(hashContent(html));
    expect(manifest.runId).toBe(html === '<p>a</p>' ? 'run-a' : 'run-b');
  });

  it('rejects a data path that was asked for but is not there', async () => {
    await publishHtml('<h1>v1</h1>', { dataRelativePath: 'findings.json' })
      .then(() => { throw new Error('should have thrown'); })
      .catch((err: unknown) => {
        expect(err).toBeInstanceOf(CanvasArtifactError);
        expect((err as CanvasArtifactError).code).toBe('data_not_found');
      });
  });

  it('keeps existing data when a republish does not mention it', async () => {
    writeSourceFile('findings.json', '{"n":1}');
    await publishHtml('<h1>v1</h1>', { dataRelativePath: 'findings.json' });

    const { artifact } = await publishHtml('<h1>v2</h1>');

    expect(artifact.hasData).toBe(true);
    expect(fs.readFileSync(path.join(artifact.dir, 'data.json'), 'utf-8')).toBe('{"n":1}');
  });
});

describe('write confinement', () => {
  it('refuses an artifact directory that symlinks out of the space', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-escape-'));
    const reports = path.join(spaceDir(), 'reports');
    fs.mkdirSync(reports, { recursive: true });
    // The agent can write anywhere in its own workspace, so it can leave a
    // symlink here and let whim do the writing.
    fs.symlinkSync(outside, path.join(reports, 'hijack'), 'dir');

    expect(() => resolveArtifactDir(workspace, FOLDER, 'hijack'))
      .toThrow(/outside the space folder/);

    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('replaces a symlinked target instead of writing through it', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-target-'));
    const victim = path.join(outside, 'victim.html');
    fs.writeFileSync(victim, 'ORIGINAL');
    const dir = resolveArtifactDir(workspace, FOLDER, 'open-questions');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(victim, path.join(dir, ARTIFACT_FILE));

    writeArtifactFile(dir, ARTIFACT_FILE, '<h1>rendered</h1>');

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(fs.readFileSync(path.join(dir, ARTIFACT_FILE), 'utf-8')).toBe('<h1>rendered</h1>');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a file name that tries to climb out of the artifact directory', () => {
    const dir = resolveArtifactDir(workspace, FOLDER, 'open-questions');
    expect(() => writeArtifactFile(dir, '../escape.html', 'x')).toThrow(/Invalid artifact file name/);
  });
});

describe('status, lookup and deletion', () => {
  it('updates status without touching content', async () => {
    const { artifact } = await publishHtml('<h1>Report</h1>');
    const updated = await setArtifactStatus({
      workspaceRoot: workspace,
      folder: FOLDER,
      artifactId: 'open-questions',
      status: '7 open questions',
    });

    expect(updated?.status).toBe('7 open questions');
    expect(updated?.contentHash).toBe(artifact.contentHash);
    expect(fs.readFileSync(artifact.htmlPath, 'utf-8')).toBe('<h1>Report</h1>');
  });

  it('returns null when setting status on an unknown artifact', async () => {
    const updated = await setArtifactStatus({
      workspaceRoot: workspace,
      folder: FOLDER,
      artifactId: 'missing',
      status: 'x',
    });
    expect(updated).toBeNull();
  });

  it('lists artifacts newest first and skips unreadable directories', async () => {
    await publishHtml('<h1>One</h1>');
    await new Promise(r => setTimeout(r, 5));
    writeSourceFile('second.html', '<h1>Two</h1>');
    await publishArtifact({
      workspaceRoot: workspace,
      folder: FOLDER,
      spaceId: SPACE_ID,
      artifactId: 'second',
      title: 'Second',
      sourceRelativePath: 'second.html',
    });

    // A directory with no manifest is not an artifact.
    fs.mkdirSync(path.join(workspace, FOLDER, 'reports', 'garbage'), { recursive: true });

    const artifacts = listArtifacts(workspace, FOLDER);
    expect(artifacts.map(a => a.artifactId)).toEqual(['second', 'open-questions']);
  });

  it('returns only published artifacts as the primary target', async () => {
    await bindArtifact({
      workspaceRoot: workspace,
      folder: FOLDER,
      spaceId: SPACE_ID,
      artifactId: 'bound-only',
      title: 'Bound only',
    });
    expect(getPrimaryArtifact(workspace, FOLDER)).toBeNull();

    await publishHtml('<h1>Report</h1>');
    expect(getPrimaryArtifact(workspace, FOLDER)?.artifactId).toBe('open-questions');
  });

  it('finds an artifact by its bound canvas instance', async () => {
    await bindArtifact({
      workspaceRoot: workspace,
      folder: FOLDER,
      spaceId: SPACE_ID,
      artifactId: 'open-questions',
      title: 'Open questions',
      instanceId: 'inst-42',
    });

    expect(findArtifactByInstance(workspace, FOLDER, 'inst-42')?.artifactId).toBe('open-questions');
    expect(findArtifactByInstance(workspace, FOLDER, 'nope')).toBeNull();
  });

  it('returns null for unknown or invalid artifact ids', () => {
    expect(getArtifact(workspace, FOLDER, 'missing')).toBeNull();
    expect(getArtifact(workspace, FOLDER, '../escape')).toBeNull();
  });

  it('deletes an artifact directory', async () => {
    const { artifact } = await publishHtml('<h1>Report</h1>');
    expect(await deleteArtifact(workspace, FOLDER, 'open-questions')).toBe(true);
    expect(fs.existsSync(artifact.dir)).toBe(false);
    expect(await deleteArtifact(workspace, FOLDER, 'open-questions')).toBe(false);
  });
});

describe('archived spaces', () => {
  it('reads artifacts from the archive location after a space is completed', async () => {
    await publishHtml('<h1>Report</h1>');

    const archived = path.join(workspace, '.whim', 'archive', FOLDER);
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(spaceDir(), archived);

    const artifacts = listArtifacts(workspace, FOLDER);
    expect(artifacts).toHaveLength(1);
    expect(fs.readFileSync(artifacts[0].htmlPath, 'utf-8')).toBe('<h1>Report</h1>');
  });
});
