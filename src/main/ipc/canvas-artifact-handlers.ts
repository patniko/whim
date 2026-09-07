/**
 * IPC for canvas artifacts.
 *
 * Reads scan the space folder rather than a table: disk is the source of truth
 * for artifacts, so they survive a projection rebuild, a git sync, or a
 * workspace moved between machines.
 */
import { getSpaceSummary as getSpace, listSpaceSummaries, isInitialized } from '../storage';
import { getConfigValue } from '../config';
import { type CanvasArtifact } from '../canvas/artifact-store';
import { listArtifacts } from '../storage';
import { buildArtifactUrl } from '../canvas/artifact-protocol';
import { openArtifactWindow } from '../canvas/artifact-window';
import { registerHandler } from './typed-handler';
import type { SpaceCanvasArtifact } from '../../shared/types';

function toPublic(artifact: CanvasArtifact): SpaceCanvasArtifact {
  return {
    artifactId: artifact.artifactId,
    spaceId: artifact.spaceId,
    title: artifact.title,
    ...(artifact.status ? { status: artifact.status } : {}),
    ...(artifact.skillId ? { skillId: artifact.skillId } : {}),
    published: artifact.published,
    updatedAt: artifact.updatedAt,
    ...(artifact.publishedAt ? { publishedAt: artifact.publishedAt } : {}),
    url: buildArtifactUrl(artifact.spaceId, artifact.artifactId),
  };
}

/** Published artifacts of one space, newest first. */
export async function listSpaceArtifacts(spaceId: string): Promise<SpaceCanvasArtifact[]> {
  const workspace = getConfigValue('workspace');
  if (!workspace) return [];

  const space = (await getSpace(spaceId));
  if (!space?.folder) return [];

  try {
    return (await listArtifacts(workspace, space.folder))
      .filter(a => a.published)
      .sort((a, b) => (b.publishedAt ?? b.updatedAt).localeCompare(a.publishedAt ?? a.updatedAt))
      .map(toPublic);
  } catch {
    return [];
  }
}

/**
 * Artifacts across every space the user has not finished with.
 *
 * Completed spaces are excluded: closing a space is how the user says they are
 * done with its report, and a tray that keeps listing them defeats that.
 */
export async function listActiveArtifacts(spaceIds?: string[], limit?: number): Promise<SpaceCanvasArtifact[]> {
  if (spaceIds && (!Array.isArray(spaceIds) || spaceIds.length > 100 || !spaceIds.every(id => typeof id === 'string'))) {
    throw new Error('Invalid artifact space page');
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) throw new Error('Invalid artifact limit');
  const workspace = getConfigValue('workspace');
  if (!workspace || !isInitialized()) return [];

  const artifacts: SpaceCanvasArtifact[] = [];
  const newestFirst = (a: SpaceCanvasArtifact, b: SpaceCanvasArtifact) => (b.publishedAt ?? b.updatedAt).localeCompare(a.publishedAt ?? a.updatedAt);
  let cursor: string | undefined;
  do {
    const page = spaceIds ? { items: await Promise.all(spaceIds.map(id => getSpace(id))), nextCursor: null }
      : await listSpaceSummaries({ limit: 100, filter: 'open', cursor });
    for (const space of page.items) {
      if (!space || space.status === 'done' || !space.folder) continue;
      for (const artifact of (await listArtifacts(workspace, space.folder))) {
        if (!artifact.published) continue;
        artifacts.push(toPublic(artifact));
        if (limit !== undefined) {
          artifacts.sort(newestFirst);
          if (artifacts.length > limit) artifacts.pop();
        }
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return artifacts.sort(newestFirst);
}

export function registerCanvasArtifactHandlers(): void {
  registerHandler('canvas-artifact:list', async (_event, spaceId) => ({
    artifacts: (await listSpaceArtifacts(spaceId)),
  }));

  registerHandler('canvas-artifact:list-all', async (_event, spaceIds) => ({ artifacts: (await listActiveArtifacts(spaceIds)) }));

  registerHandler('canvas-artifact:open', async (_event, spaceId, artifactId) => {
    const artifact = (await listSpaceArtifacts(spaceId)).find(a => a.artifactId === artifactId);
    if (!artifact) return { error: 'Report not found' };

    // The user asked for it, so this one does take focus.
    openArtifactWindow({ spaceId, artifactId, title: artifact.title, focus: true });
    return { ok: true as const };
  });
}
