import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  session: { fromPartition: vi.fn(() => ({ protocol: { handle: vi.fn() } })) },
}));

import { publishArtifact, bindArtifact } from './artifact-store';
import {
  ARTIFACT_CSP,
  ARTIFACT_SCHEME,
  buildArtifactUrl,
  parseArtifactUrl,
  resolveArtifactRequest,
  stripMetaRefresh,
  type SpaceResolver,
} from './artifact-protocol';

let workspace: string;
const FOLDER = 'spaces/open-questions';
const SPACE_ID = 'space-1';
const ARTIFACT_ID = 'open-questions';

function spaceDir(): string {
  return path.join(workspace, FOLDER);
}

const resolveSpace: SpaceResolver = spaceId =>
  spaceId === SPACE_ID ? { workspaceRoot: workspace, folder: FOLDER } : null;

async function publish(html = '<h1>Report</h1>') {
  fs.writeFileSync(path.join(spaceDir(), 'report.html'), html, 'utf-8');
  return publishArtifact({
    workspaceRoot: workspace,
    folder: FOLDER,
    spaceId: SPACE_ID,
    artifactId: ARTIFACT_ID,
    title: 'Open questions',
    sourceRelativePath: 'report.html',
  });
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-protocol-'));
  fs.mkdirSync(spaceDir(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('parseArtifactUrl', () => {
  it('parses a well-formed url and defaults to index.html', () => {
    expect(parseArtifactUrl(buildArtifactUrl(SPACE_ID, ARTIFACT_ID))).toEqual({
      spaceId: SPACE_ID,
      artifactId: ARTIFACT_ID,
      file: 'index.html',
    });
  });

  it('parses a nested asset path', () => {
    expect(parseArtifactUrl(buildArtifactUrl(SPACE_ID, ARTIFACT_ID, 'assets/style.css'))?.file).toBe(
      'assets/style.css',
    );
  });

  it('round-trips space ids that need encoding', () => {
    const url = buildArtifactUrl('space/with slash', ARTIFACT_ID);
    expect(parseArtifactUrl(url)?.spaceId).toBe('space/with slash');
  });

  it('rejects other schemes and hosts', () => {
    expect(parseArtifactUrl(`copilot-whim://app/${SPACE_ID}/${ARTIFACT_ID}/index.html`)).toBeNull();
    expect(parseArtifactUrl(`${ARTIFACT_SCHEME}://other/${SPACE_ID}/${ARTIFACT_ID}/index.html`)).toBeNull();
    expect(parseArtifactUrl('not a url')).toBeNull();
  });

  it('rejects traversal, including percent-encoded traversal', () => {
    // The URL parser normalizes literal `..` away, which re-points the request
    // at a different space id rather than escaping — that resolves to nothing.
    expect(parseArtifactUrl(`${ARTIFACT_SCHEME}://space/${SPACE_ID}/../../etc/passwd`)).toMatchObject({
      spaceId: 'etc',
      artifactId: 'passwd',
    });
    // A percent-encoded `..` that the parser normalizes just re-points at a
    // different artifact id, which is still contained.
    expect(parseArtifactUrl(`${ARTIFACT_SCHEME}://space/${SPACE_ID}/${ARTIFACT_ID}/%2e%2e/secret`)).toMatchObject({
      spaceId: SPACE_ID,
      artifactId: 'secret',
    });
    // An encoded separator survives normalization and must be rejected.
    expect(parseArtifactUrl(`${ARTIFACT_SCHEME}://space/${SPACE_ID}/${ARTIFACT_ID}/%2e%2e%2fsecret`)).toBeNull();
    expect(parseArtifactUrl(`${ARTIFACT_SCHEME}://space/${SPACE_ID}`)).toBeNull();
  });
});

describe('resolveArtifactRequest', () => {
  it('serves a published artifact with hardened headers', async () => {
    await publish();
    const result = resolveArtifactRequest(buildArtifactUrl(SPACE_ID, ARTIFACT_ID), resolveSpace);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(fs.readFileSync(result.filePath, 'utf-8')).toBe('<h1>Report</h1>');
    expect(result.mimeType).toBe('text/html; charset=utf-8');
    expect(result.headers['Content-Security-Policy']).toBe(ARTIFACT_CSP);
    expect(result.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(result.headers['Referrer-Policy']).toBe('no-referrer');
  });

  it('blocks all scripting through the CSP', () => {
    // No script-src directive is emitted, so default-src 'none' governs scripts.
    expect(ARTIFACT_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_CSP).not.toContain('script-src');
    expect(ARTIFACT_CSP).toContain("frame-ancestors 'none'");
  });

  it('404s for an unknown space or artifact', async () => {
    await publish();
    expect(resolveArtifactRequest(buildArtifactUrl('nope', ARTIFACT_ID), resolveSpace)).toMatchObject({
      ok: false,
      status: 404,
      reason: 'unknown_space',
    });
    expect(resolveArtifactRequest(buildArtifactUrl(SPACE_ID, 'missing'), resolveSpace)).toMatchObject({
      ok: false,
      status: 404,
      reason: 'unknown_artifact',
    });
  });

  it('404s for a bound-but-unpublished artifact', async () => {
    await bindArtifact({
      workspaceRoot: workspace,
      folder: FOLDER,
      spaceId: SPACE_ID,
      artifactId: ARTIFACT_ID,
      title: 'Open questions',
    });

    expect(resolveArtifactRequest(buildArtifactUrl(SPACE_ID, ARTIFACT_ID), resolveSpace)).toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('400s on a malformed url', () => {
    expect(resolveArtifactRequest('garbage', resolveSpace)).toMatchObject({ ok: false, status: 400 });
  });

  it('refuses to serve a symlink that escapes the artifact directory', async () => {
    const { artifact } = await publish();
    const secretPath = path.join(workspace, 'secret.txt');
    fs.writeFileSync(secretPath, 'secret', 'utf-8');
    fs.symlinkSync(secretPath, path.join(artifact.dir, 'leak.txt'));

    expect(resolveArtifactRequest(buildArtifactUrl(SPACE_ID, ARTIFACT_ID, 'leak.txt'), resolveSpace)).toMatchObject({
      ok: false,
      status: 403,
      reason: 'escape',
    });
  });

  it('refuses to serve the sibling manifest of another artifact', async () => {
    await publish();
    // ../ inside the file segment is rejected before it reaches the filesystem.
    expect(
      resolveArtifactRequest(`${ARTIFACT_SCHEME}://space/${SPACE_ID}/${ARTIFACT_ID}/../other/index.html`, resolveSpace),
    ).toMatchObject({ ok: false });
  });

  it('rejects file types that are not on the allowlist', async () => {
    const { artifact } = await publish();
    fs.writeFileSync(path.join(artifact.dir, 'payload.js'), 'alert(1)', 'utf-8');

    expect(resolveArtifactRequest(buildArtifactUrl(SPACE_ID, ARTIFACT_ID, 'payload.js'), resolveSpace)).toMatchObject({
      ok: false,
      status: 415,
    });
  });

  it('serves allowlisted assets alongside the document', async () => {
    const { artifact } = await publish();
    fs.mkdirSync(path.join(artifact.dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(artifact.dir, 'assets', 'style.css'), 'body{}', 'utf-8');

    const result = resolveArtifactRequest(buildArtifactUrl(SPACE_ID, ARTIFACT_ID, 'assets/style.css'), resolveSpace);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mimeType).toBe('text/css; charset=utf-8');
  });

  it('404s when the artifact directory is a directory rather than a file', async () => {
    const { artifact } = await publish();
    fs.mkdirSync(path.join(artifact.dir, 'assets'), { recursive: true });

    expect(resolveArtifactRequest(buildArtifactUrl(SPACE_ID, ARTIFACT_ID, 'assets'), resolveSpace)).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});

describe('stripMetaRefresh', () => {
  it('removes a meta refresh, the one way an inert page can navigate itself', () => {
    const html = '<head><meta http-equiv="refresh" content="0;url=https://evil.example"></head><p>hi</p>';

    const cleaned = stripMetaRefresh(html);

    expect(cleaned).not.toMatch(/http-equiv/i);
    expect(cleaned).toContain('<p>hi</p>');
  });

  it('removes it however the author spelled it', () => {
    const variants = [
      "<meta HTTP-EQUIV='REFRESH' content='0'>",
      '<meta content="0;url=/x" http-equiv=refresh>',
      '<meta http-equiv = "refresh" content="1">',
    ];

    for (const html of variants) {
      expect(stripMetaRefresh(html)).not.toMatch(/refresh/i);
    }
  });

  it('leaves other meta tags alone', () => {
    const html = '<meta charset="utf-8"><meta name="viewport" content="width=device-width">';

    expect(stripMetaRefresh(html)).toBe(html);
  });
});
