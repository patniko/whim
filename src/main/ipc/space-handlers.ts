import { registerIpcHandler } from './registry';
import { isInitialized, createSpace, listSpaces, getSpace, listSpaceEvents, searchSpaces } from '../database';
import { parseSpaceWithAI, resolveDateWithAI, classifyInput } from '../ai';
import { CreateSpaceInput, Space } from '../../shared/types';
import { getConfigValue } from '../config';
import { materializeSpaceCanvas, scheduleAutoCommit } from '../workspace';
import { dismissRecurrence } from '../services/recurrence';
import { processSpaceInBackground } from '../services/space-processing';
import { applySpaceUpdate, deleteSpaceFull, unarchiveSpaceFull } from '../services/space-mutations';
import { getActivityStats } from '../activity-stats';
import type { ActivityTotals } from '../../shared/types';

/** Shown before a workspace exists, so the view renders its zero state. */
const EMPTY_ACTIVITY_TOTALS: ActivityTotals = {
  tokens: 0, agents: 0, subagents: 0, spaces: 0, toolCalls: 0,
  peakParallelAgents: 0, activeDays: 0, currentStreak: 0, longestStreak: 0,
  busiestDay: null,
};

export function registerSpaceHandlers(): void {
  registerIpcHandler('space:create', (_event, input: CreateSpaceInput) => {
    if (!isInitialized()) return { error: 'no_workspace' };
    // createSpace records the (deterministic) folder name in the single create
    // event, so the IPC can return immediately after the DB write.
    const space = createSpace(input);

    // Materialize the folder + seed the canvas off the critical path. The folder
    // name is already known/persisted; the on-disk write does not block the reply.
    const workspace = getConfigValue('workspace');
    if (workspace && space.folder) {
      const folder = space.folder;
      void materializeSpaceCanvas(workspace, folder, space.body)
        .then(() => scheduleAutoCommit(workspace))
        .catch((err) => console.error('[space:create] Canvas materialization failed:', err));
    }

    processSpaceInBackground(space.id, space.body || space.description, space.updated_at);
    return space;
  });

  registerIpcHandler('space:list', () => {
    if (!isInitialized()) return [];
    return listSpaces();
  });

  registerIpcHandler('space:update', async (_event, id: string, updates: Partial<Pick<Space, 'description' | 'body' | 'client' | 'due_at' | 'due_at_utc' | 'status' | 'attachments'>>) => {
    return applySpaceUpdate(id, updates);
  });

  registerIpcHandler('space:delete', (_event, id: string) => {
    return deleteSpaceFull(id);
  });

  registerIpcHandler('space:dismiss-recurrence', (_event, id: string) => {
    dismissRecurrence(id);
    return true;
  });

  // Space events / timeline
  registerIpcHandler('space:events', (_event, limit?: number) => {
    return listSpaceEvents(limit || 100);
  });

  registerIpcHandler('activity:stats', (_event, windowDays?: number) => {
    if (!isInitialized()) return { days: [], totals: EMPTY_ACTIVITY_TOTALS };
    return getActivityStats(windowDays && windowDays > 0 ? Math.min(windowDays, 730) : undefined);
  });

  // Resolve natural language date
  registerIpcHandler('space:resolve-date', async (_event, dateText: string) => {
    return resolveDateWithAI(dateText);
  });

  // Classify user input as space vs query
  registerIpcHandler('space:classify', async (_event, text: string) => {
    if (!isInitialized()) return { type: 'space' };
    const allSpaces = listSpaces();
    const recent = allSpaces.map(i => ({
      description: i.description,
      status: i.status,
      due_at: i.due_at,
      completed_at: i.completed_at,
    }));
    return classifyInput(text, recent);
  });

  // Summarize canvas content into a title
  registerIpcHandler('space:summarize-title', async (_event, canvasContent: string) => {
    try {
      const parsed = await parseSpaceWithAI(canvasContent);
      return { title: parsed.description };
    } catch (err) {
      console.error('[ipc] Summarize title failed:', err);
      return { title: null };
    }
  });

  registerIpcHandler('space:search', (_event, query: string) => {
    if (!isInitialized()) return [];
    return searchSpaces(query);
  });

  registerIpcHandler('space:unarchive', async (_event, id: string) => {
    return unarchiveSpaceFull(id);
  });
}
