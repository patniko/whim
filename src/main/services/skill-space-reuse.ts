/**
 * Which space a skill run should write into.
 *
 * A skill that runs every morning would otherwise leave a space per occurrence,
 * and a hundred near-identical spaces is worse than no report at all: the user
 * loses the thread and starts ignoring them. So repeat runs refresh the space
 * the user already knows, and a skill that genuinely wants a fresh space per
 * occurrence has to say so.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getLatestSpaceForSkill, hasActiveAgentForSpace } from '../database';
import { cancelPendingRecurrence } from './recurrence';
import { unarchiveSpaceFull } from './space-mutations';
import type { Space } from '../../shared/types';

export type SpaceReuseReason =
  | 'reused'
  | 'reopened'
  | 'new-first-run'
  | 'new-requested'
  | 'new-folder-missing'
  | 'new-agent-running';

export interface SpaceResolution {
  space: Space | null;
  reason: SpaceReuseReason;
}

export interface ResolveSpaceParams {
  skillId: string;
  workspaceRoot: string;
  /** `new` means every occurrence gets its own space. */
  spaceMode?: 'new' | 'reuse';
}

/**
 * Find the space this run should use, or `null` when a new one should be created.
 *
 * Every "create a new one instead" path is deliberate rather than a failure:
 * dropping the occurrence would silently skip a scheduled run, which is harder
 * to notice than an extra space.
 */
export async function resolveSpaceForSkill(params: ResolveSpaceParams): Promise<SpaceResolution> {
  const { skillId, workspaceRoot, spaceMode } = params;

  if (spaceMode === 'new') return { space: null, reason: 'new-requested' };

  const existing = getLatestSpaceForSkill(skillId);
  if (!existing) return { space: null, reason: 'new-first-run' };

  // Writing into a space that is mid-run would have two agents editing the same
  // document and artifact at once.
  if (hasActiveAgentForSpace(existing.id)) {
    return { space: null, reason: 'new-agent-running' };
  }

  const wasCompleted = existing.status === 'done';
  let space = existing;

  if (wasCompleted) {
    // Completing a space archives its folder, so reuse has to go through the
    // unarchive path — clearing `completed_at` alone would leave the run
    // pointing at a directory that is not there.
    const reopened = await unarchiveSpaceFull(existing.id);
    if (!reopened) return { space: null, reason: 'new-folder-missing' };
    space = reopened;
    // The space is active again, so a recurrence queued by its completion would
    // now duplicate the work this run is about to do.
    try {
      cancelPendingRecurrence(space.id);
    } catch { /* recurrence bookkeeping is best-effort */ }
  }

  if (!space.folder || !fs.existsSync(path.join(workspaceRoot, space.folder))) {
    return { space: null, reason: 'new-folder-missing' };
  }

  return { space, reason: wasCompleted ? 'reopened' : 'reused' };
}

/**
 * Extra prompt framing for a run that is refreshing an existing space.
 *
 * Without this the agent treats a reused space as a blank one and rewrites the
 * report from scratch, losing whatever the user had already read and acted on.
 */
export function buildRefreshFraming(priorArtifacts: Array<{ artifactId: string; title: string; relativeHtmlPath: string; relativeDataPath?: string }>): string {
  if (!priorArtifacts.length) return '';

  const lines = priorArtifacts.map(a => {
    const data = a.relativeDataPath ? `, data: \`${a.relativeDataPath}\`` : '';
    return `- "${a.title}" (artifactId \`${a.artifactId}\`): \`${a.relativeHtmlPath}\`${data}`;
  });

  return [
    '',
    '## Refreshing an existing report',
    '',
    'This space already holds output from an earlier run:',
    '',
    ...lines,
    '',
    'Read the previous report before writing a new one. Publish to the same `artifactId` so the',
    'user sees one report that stays current rather than a pile of near-identical ones, and call',
    'out what changed since last time — what is new, what was resolved, and what is still open.',
  ].join('\n');
}
