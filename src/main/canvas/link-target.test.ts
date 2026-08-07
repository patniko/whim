/**
 * What a link in a canvas refers to.
 *
 * These rules used to be tangled up with the act of opening — a workspace
 * `.md` file *became* `openFileInNewWindow`, an http URL *became*
 * `shell.openExternal` — so they could only be exercised with an Electron
 * shell standing by, and they could not be exercised at all from a browser,
 * which is where they were silently doing nothing.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';

import { resolveLinkTarget } from './link-target';

const BASE = '/workspace/spaces/notes';

/** Only markdown under the workspace counts as a canvas. */
const isWorkspaceMdFile = (filePath: string) =>
  filePath.startsWith('/workspace/') && filePath.endsWith('.md');

const ctx = { baseDir: BASE, isWorkspaceMdFile };

describe('resolveLinkTarget', () => {
  it('treats an http URL as external', () => {
    expect(resolveLinkTarget('https://example.com/docs', ctx)).toEqual({
      kind: 'external',
      url: 'https://example.com/docs',
    });
  });

  it('treats mailto as external', () => {
    // Regression: `mailto:` has no `//`, so it used to fall through to the
    // relative-path branch and become a nonexistent file inside the space.
    expect(resolveLinkTarget('mailto:someone@example.com', ctx)).toEqual({
      kind: 'external',
      url: 'mailto:someone@example.com',
    });
  });

  it('keeps the fragment on an external URL', () => {
    // The fragment is stripped only so the filesystem checks see a bare path;
    // it is still part of where the link points.
    expect(resolveLinkTarget('https://example.com/docs#install', ctx)).toEqual({
      kind: 'external',
      url: 'https://example.com/docs#install',
    });
  });

  it('resolves a relative markdown link to a canvas', () => {
    expect(resolveLinkTarget('sibling.md', ctx)).toEqual({
      kind: 'canvas',
      filePath: path.join(BASE, 'sibling.md'),
    });
  });

  it('resolves a relative link with a heading fragment', () => {
    expect(resolveLinkTarget('sibling.md#section', ctx)).toEqual({
      kind: 'canvas',
      filePath: path.join(BASE, 'sibling.md'),
    });
  });

  it('decodes percent-encoded relative paths', () => {
    expect(resolveLinkTarget('my%20notes.md', ctx)).toEqual({
      kind: 'canvas',
      filePath: path.join(BASE, 'my notes.md'),
    });
  });

  it('resolves an absolute path', () => {
    expect(resolveLinkTarget('/workspace/other/plan.md', ctx)).toEqual({
      kind: 'canvas',
      filePath: '/workspace/other/plan.md',
    });
  });

  it('resolves a file:// URL', () => {
    expect(resolveLinkTarget('file:///workspace/other/plan.md', ctx)).toEqual({
      kind: 'canvas',
      filePath: '/workspace/other/plan.md',
    });
  });

  it('treats a non-markdown file as a plain file', () => {
    expect(resolveLinkTarget('report.pdf', ctx)).toEqual({
      kind: 'file',
      filePath: path.join(BASE, 'report.pdf'),
    });
  });

  it('treats markdown outside the workspace as a plain file', () => {
    expect(resolveLinkTarget('/elsewhere/notes.md', ctx)).toEqual({
      kind: 'file',
      filePath: '/elsewhere/notes.md',
    });
  });

  it('resolves nothing for a relative link with no base directory', () => {
    // A skill canvas has no attachment folder, so a relative link has nothing
    // to be relative to.
    expect(resolveLinkTarget('sibling.md', { ...ctx, baseDir: null })).toEqual({
      kind: 'none',
      reason: 'unresolved',
    });
  });

  it('resolves nothing for an unknown scheme', () => {
    expect(resolveLinkTarget('ftp://example.com/x', ctx)).toEqual({
      kind: 'none',
      reason: 'unresolved',
    });
  });

  it('reports a malformed file:// URL rather than throwing', () => {
    expect(resolveLinkTarget('file://%%%', ctx)).toEqual({ kind: 'none', reason: 'invalid_url' });
  });

  it('makes no decision that names a host action', () => {
    // The point of this module: the result says what a link *is*, never what
    // to do about it, so a browser can apply it too.
    const results = [
      resolveLinkTarget('https://example.com', ctx),
      resolveLinkTarget('sibling.md', ctx),
      resolveLinkTarget('report.pdf', ctx),
    ];
    for (const result of results) {
      expect(Object.keys(result)).not.toContain('action');
    }
  });
});
