/**
 * Resolve a space id to the files on disk that belong to it.
 *
 * Kept separate from the protocol handler so that handler stays free of the
 * database and remains directly unit testable.
 */
import { getConfigValue } from '../config';
import { getSpace } from '../database';
import type { SpaceLocation } from './artifact-protocol';

export function resolveSpaceLocation(spaceId: string): SpaceLocation | null {
  const workspaceRoot = getConfigValue('workspace');
  if (!workspaceRoot) return null;

  const space = getSpace(spaceId);
  if (!space?.folder) return null;

  return { workspaceRoot, folder: space.folder };
}
