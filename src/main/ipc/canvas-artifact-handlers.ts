/**
 * IPC for canvas artifacts.
 *
 * Reads scan the space folder rather than a table: disk is the source of truth
 * for artifacts, so they survive a projection rebuild, a git sync, or a
 * workspace moved between machines.
 */
import { getSpace, listSpaces } from '../database';
import { getConfigValue } from '../config';
import { listArtifacts, type CanvasArtifact } from '../canvas/artifact-store';
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
export function listSpaceArtifacts(spaceId: string): SpaceCanvasArtifact[] {
  const workspace = getConfigValue('workspace');
  if (!workspace) return [];

  const space = getSpace(spaceId);
  if (!space?.folder) return [];

  try {
    return listArtifacts(workspace, space.folder)
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
export function listActiveArtifacts(): SpaceCanvasArtifact[] {
  const workspace = getConfigValue('workspace');
  if (!workspace) return [];

  const artifacts: SpaceCanvasArtifact[] = [];
  for (const space of listSpaces()) {
    if (space.status === 'done' || !space.folder) continue;
    try {
      for (const artifact of listArtifacts(workspace, space.folder)) {
        if (artifact.published) artifacts.push(toPublic(artifact));
      }
    } catch { /* a space folder that cannot be read simply has no artifacts */ }
  }
  return artifacts.sort((a, b) => (b.publishedAt ?? b.updatedAt).localeCompare(a.publishedAt ?? a.updatedAt));
}

export function registerCanvasArtifactHandlers(): void {
  registerHandler('canvas-artifact:list', (_event, spaceId) => ({
    artifacts: listSpaceArtifacts(spaceId),
  }));

  registerHandler('canvas-artifact:list-all', () => ({ artifacts: listActiveArtifacts() }));

  registerHandler('canvas-artifact:open', (_event, spaceId, artifactId) => {
    const artifact = listSpaceArtifacts(spaceId).find(a => a.artifactId === artifactId);
    if (!artifact) return { error: 'Report not found' };

    // The user asked for it, so this one does take focus.
    openArtifactWindow({ spaceId, artifactId, title: artifact.title, focus: true });
    return { ok: true as const };
  });
}
