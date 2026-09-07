/**
 * Resolve a space id to the files on disk that belong to it.
 *
 * Kept separate from the protocol handler so that handler stays free of the
 * database and remains directly unit testable.
 */
import { getConfigValue } from '../config';
import { getSpace } from '../storage';
import type { SpaceLocation } from './artifact-protocol';

export async function resolveSpaceLocation(spaceId: string): Promise<SpaceLocation | null> {
  const workspaceRoot = getConfigValue('workspace');
  if (!workspaceRoot) return null;

  const space = (await getSpace(spaceId));
  if (!space?.folder) return null;

  return { workspaceRoot, folder: space.folder };
}
