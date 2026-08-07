/**
 * Regression: a canvas is not always a space.
 *
 * Pages and loose workspace files are addressed by synthetic ids, and the
 * handlers that serve canvas files used to look every id up as a real space —
 * so an image inside a page or a linked file resolved to `not_found` on the
 * desktop as well as over the web remote.
 *
 * These tests also pin the containment rules, because this resolver now backs
 * an HTTP endpoint a browser can reach: the id and the path both arrive from
 * the client, so neither may be able to name a file outside the canvas.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveCanvasFileRoot,
  resolveCanvasFile,
  readCanvasFile,
  type SpaceFolderLookup,
} from './canvas-file-root';

let workspace: string;
let outside: string;

const SPACE_ID = 'space-1';
const FOLDER = 'spaces/notes';

const lookup: SpaceFolderLookup = (id) => (id === SPACE_ID ? FOLDER : null);

function spaceDir(): string {
  return path.join(workspace, FOLDER);
}

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-file-root-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-outside-')));
  fs.mkdirSync(path.join(spaceDir(), 'assets'), { recursive: true });
  fs.writeFileSync(path.join(spaceDir(), 'assets', 'diagram.png'), 'PNG');
  fs.writeFileSync(path.join(spaceDir(), 'canvas.md'), '# notes');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'classified');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('resolveCanvasFileRoot', () => {
  it('resolves a real space to its folder', () => {
    expect(resolveCanvasFileRoot(workspace, SPACE_ID, lookup)).toBe(spaceDir());
  });

  it('resolves a page to its owning space folder', () => {
    const pageId = `__page__${SPACE_ID}/${encodeURIComponent('Meeting notes')}`;
    expect(resolveCanvasFileRoot(workspace, pageId, lookup)).toBe(spaceDir());
  });

  it('resolves a linked workspace file to its own directory', () => {
    const target = path.join(spaceDir(), 'assets', 'notes.md');
    const fileId = `__file__${encodeURIComponent(target)}`;
    expect(resolveCanvasFileRoot(workspace, fileId, lookup)).toBe(path.join(spaceDir(), 'assets'));
  });

  it('refuses a linked file outside the workspace', () => {
    // The id reaches us from the renderer, which over the web remote means
    // from a browser. Without this, a crafted id reads anywhere on disk.
    const fileId = `__file__${encodeURIComponent(path.join(outside, 'secret.txt'))}`;
    expect(resolveCanvasFileRoot(workspace, fileId, lookup)).toBeNull();
  });

  it('refuses a relative linked-file path', () => {
    expect(resolveCanvasFileRoot(workspace, '__file__../../etc/passwd', lookup)).toBeNull();
  });

  it('has no root for a skill', () => {
    expect(resolveCanvasFileRoot(workspace, '__skill__my-skill', lookup)).toBeNull();
  });

  it('has no root for an unknown space', () => {
    expect(resolveCanvasFileRoot(workspace, 'nope', lookup)).toBeNull();
  });

  it('has no root for a page whose space is gone', () => {
    expect(resolveCanvasFileRoot(workspace, '__page__missing/Notes', lookup)).toBeNull();
  });
});

describe('resolveCanvasFile', () => {
  it('finds an attachment in a space', () => {
    expect(resolveCanvasFile(workspace, SPACE_ID, 'assets/diagram.png', lookup)).toBe(
      path.join(spaceDir(), 'assets', 'diagram.png'),
    );
  });

  it('finds the same attachment from a page in that space', () => {
    const pageId = `__page__${SPACE_ID}/Notes`;
    expect(resolveCanvasFile(workspace, pageId, 'assets/diagram.png', lookup)).toBe(
      path.join(spaceDir(), 'assets', 'diagram.png'),
    );
  });

  it('finds a sibling of a linked workspace file', () => {
    const fileId = `__file__${encodeURIComponent(path.join(spaceDir(), 'canvas.md'))}`;
    expect(resolveCanvasFile(workspace, fileId, 'assets/diagram.png', lookup)).toBe(
      path.join(spaceDir(), 'assets', 'diagram.png'),
    );
  });

  it('refuses a path that escapes the canvas', () => {
    expect(resolveCanvasFile(workspace, SPACE_ID, '../../../etc/passwd', lookup)).toBeNull();
  });

  it('refuses a symlink pointing out of the canvas', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(spaceDir(), 'leak.txt'));
    expect(resolveCanvasFile(workspace, SPACE_ID, 'leak.txt', lookup)).toBeNull();
  });

  it('refuses a directory', () => {
    // Streaming a directory throws, and the HTTP endpoint must not fault.
    expect(resolveCanvasFile(workspace, SPACE_ID, 'assets', lookup)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(resolveCanvasFile(workspace, SPACE_ID, 'assets/nope.png', lookup)).toBeNull();
  });
});

describe('readCanvasFile', () => {
  it('reads bytes and a MIME type', () => {
    const result = readCanvasFile(workspace, SPACE_ID, 'assets/diagram.png', lookup);
    expect(result?.data.toString()).toBe('PNG');
    expect(result?.mimeType).toBe('image/png');
  });

  it('reads an image referenced from a page', () => {
    const result = readCanvasFile(workspace, `__page__${SPACE_ID}/Notes`, 'assets/diagram.png', lookup);
    expect(result?.data.toString()).toBe('PNG');
  });

  it('returns null rather than throwing when the canvas has no root', () => {
    expect(readCanvasFile(workspace, '__skill__x', 'a.png', lookup)).toBeNull();
  });
});
