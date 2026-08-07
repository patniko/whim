import * as fs from 'fs';
import * as path from 'path';
import { assignSpaceFolder, getSpace } from '../database';
import { initSpaceCanvas, resolveSpaceFolder, sanitizePageName } from '../workspace';

export interface CommentLaunchTarget {
  launchSpaceId: string;
  realSpaceId: string;
  folder: string;
  documentPath?: string;
  documentDisplayName?: string;
  documentLabel?: string;
}

export function pageCanvasSpaceId(spaceId: string, pageName: string): string {
  return `__page__${spaceId}/${encodeURIComponent(pageName)}`;
}

/** Split a synthetic page id back into the space it belongs to and its page. */
export function parseSyntheticPageId(spaceId: string): { realSpaceId: string; pageName: string } | null {
  if (!spaceId.startsWith('__page__')) return null;
  const rest = spaceId.slice('__page__'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;
  try {
    return {
      realSpaceId: rest.slice(0, slashIdx),
      pageName: decodeURIComponent(rest.slice(slashIdx + 1)),
    };
  } catch {
    return null;
  }
}

export function resolveCommentLaunchTarget(spaceId: string, workspace: string): CommentLaunchTarget | { error: string } {
  let launchSpaceId = spaceId;
  let realSpaceId = spaceId;
  let pageName: string | null = null;

  if (spaceId.startsWith('__page__')) {
    const rest = spaceId.slice('__page__'.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx <= 0) return { error: 'invalid_page_id' };
    realSpaceId = rest.slice(0, slashIdx);
    try {
      pageName = decodeURIComponent(rest.slice(slashIdx + 1));
    } catch {
      return { error: 'invalid_page_id' };
    }
    launchSpaceId = spaceId;
  }

  const space = getSpace(realSpaceId);
  if (!space) return { error: 'space_not_found' };

  let folder = space.folder;
  if (!folder) {
    folder = initSpaceCanvas(workspace, realSpaceId, space.description, space.body);
    assignSpaceFolder(realSpaceId, folder);
  }

  if (!pageName) return { launchSpaceId, realSpaceId, folder };

  const slug = sanitizePageName(pageName);
  if (!slug) return { error: 'invalid_page_id' };
  const documentPath = path.join(resolveSpaceFolder(workspace, folder), `${slug}.md`);
  if (!fs.existsSync(documentPath)) return { error: 'page_not_found' };

  return {
    launchSpaceId,
    realSpaceId,
    folder,
    documentPath,
    documentDisplayName: `${slug}.md`,
    documentLabel: 'child page document',
  };
}
