/**
 * Where a canvas's relative file references resolve from.
 *
 * A canvas is not always a space. The renderer addresses pages and loose
 * workspace files through synthetic space ids — `__page__<spaceId>/<name>`,
 * `__file__<encoded absolute path>`, `__skill__<id>` — and the handlers that
 * serve canvas files were looking every one of them up as a real space. That
 * lookup returns nothing for a synthetic id, so an image inside a page or a
 * linked file resolved to `not_found` on the desktop as well as the web.
 *
 * The base-directory rules already existed, spread across the handlers that
 * happened to need them. They live here now so the two paths that serve bytes
 * to a canvas — `canvas:read-file` over IPC and `/api/attachment` over the web
 * remote — agree about what a canvas id means, instead of drifting apart.
 *
 * The space lookup is injected rather than imported so this stays testable
 * without a database, and so the web server does not pull the IPC layer in.
 */
import * as fs from 'fs';
import * as path from 'path';

import { resolveSpaceFolder, resolveFileInDir, isPathContainedBy, getMimeType } from '../workspace';
import { parseSyntheticPageId } from '../services/comment-launch-target';

export const FILE_CANVAS_PREFIX = '__file__';
export const SKILL_CANVAS_PREFIX = '__skill__';

/** Returns a space's workspace-relative folder, or null if there is no such space. */
export type SpaceFolderLookup = (spaceId: string) => string | null;

/**
 * The directory a canvas's relative paths are resolved against, or null when
 * the canvas has no meaningful one.
 */
export function resolveCanvasFileRoot(
  workspaceRoot: string,
  spaceId: string,
  lookupFolder: SpaceFolderLookup,
): string | null {
  // A loose workspace file: its own directory. The id names an absolute path
  // and reaches us from the renderer, which over the web remote means from a
  // browser — so it is confined to the workspace here. Without that, a crafted
  // id would turn a canvas file read into a read of anywhere on disk.
  if (spaceId.startsWith(FILE_CANVAS_PREFIX)) {
    let filePath: string;
    try {
      filePath = decodeURIComponent(spaceId.slice(FILE_CANVAS_PREFIX.length));
    } catch {
      return null;
    }
    if (!filePath || !path.isAbsolute(filePath)) return null;
    if (!isPathContainedBy(workspaceRoot, filePath)) return null;
    return path.dirname(filePath);
  }

  // A page belongs to a real space, and its images sit in that space's folder.
  const page = parseSyntheticPageId(spaceId);
  if (page) {
    const folder = lookupFolder(page.realSpaceId);
    return folder ? resolveSpaceFolder(workspaceRoot, folder) : null;
  }

  // Skills are not workspace content and have no attachment folder.
  if (spaceId.startsWith(SKILL_CANVAS_PREFIX)) return null;

  const folder = lookupFolder(spaceId);
  return folder ? resolveSpaceFolder(workspaceRoot, folder) : null;
}

/** Absolute path of a file referenced by a canvas, or null if it escapes or is missing. */
export function resolveCanvasFile(
  workspaceRoot: string,
  spaceId: string,
  relativePath: string,
  lookupFolder: SpaceFolderLookup,
): string | null {
  const root = resolveCanvasFileRoot(workspaceRoot, spaceId, lookupFolder);
  if (!root) return null;
  const resolved = resolveFileInDir(root, relativePath);
  if (!resolved) return null;
  // Directories are not files to serve, and streaming one throws.
  return fs.statSync(resolved).isFile() ? resolved : null;
}

/** Read a canvas file's bytes and MIME type, or null if it cannot be served. */
export function readCanvasFile(
  workspaceRoot: string,
  spaceId: string,
  relativePath: string,
  lookupFolder: SpaceFolderLookup,
): { data: Buffer; mimeType: string; path: string } | null {
  const resolved = resolveCanvasFile(workspaceRoot, spaceId, relativePath, lookupFolder);
  if (!resolved) return null;
  return { data: fs.readFileSync(resolved), mimeType: getMimeType(resolved), path: resolved };
}
