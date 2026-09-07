import { registerIpcHandler } from './registry';
import { isInitialized, createSpace, listSpaces, getSpace, listSpaceEvents, searchSpaces, listSpaceSummaries, listSpaceEventsPage } from '../storage';
import { parseSpaceWithAI, resolveDateWithAI, classifyInput } from '../ai';
import { CreateSpaceInput, Space } from '../../shared/types';
import { getConfigValue } from '../config';
import { scheduleAutoCommit } from '../workspace';
import { materializeSpaceCanvas } from '../storage';
import { dismissRecurrence } from '../services/recurrence';
import { processSpaceInBackground } from '../services/space-processing';
import { applySpaceUpdate, deleteSpaceFull, unarchiveSpaceFull } from '../services/space-mutations';
import { getActivityStats, listActivityPage } from '../storage';
import type { ActivityTotals } from '../../shared/types';

/** Shown before a workspace exists, so the view renders its zero state. */
const EMPTY_ACTIVITY_TOTALS: ActivityTotals = {
  tokens: 0, agents: 0, subagents: 0, spaces: 0, toolCalls: 0,
  peakParallelAgents: 0, activeDays: 0, currentStreak: 0, longestStreak: 0,
  busiestDay: null,
};

export function registerSpaceHandlers(): void {
  registerIpcHandler('space:create', async (_event, input: CreateSpaceInput) => {
    if (!isInitialized()) return { error: 'no_workspace' };
    // createSpace records the (deterministic) folder name in the single create
    // event, so the IPC can return immediately after the DB write.
    const space = (await createSpace(input));

    // Materialize the folder + seed the canvas off the critical path. The folder
    // name is already known/persisted; the on-disk write does not block the reply.
    const workspace = getConfigValue('workspace');
    if (workspace && space.folder) {
      const folder = space.folder;
      void materializeSpaceCanvas(workspace, folder, space.body)
        .then(() => scheduleAutoCommit(workspace))
        .catch((err) => console.error('[space:create] Canvas materialization failed:', err));
    }

    void processSpaceInBackground(space.id, space.body || space.description, space.updated_at)
      .catch(error => console.error('[space:create] Enrichment failed:', error));
    return space;
  });

  registerIpcHandler('space:list', async () => {
    if (!isInitialized()) return [];
    return (await listSpaces());
  });
  registerIpcHandler('space:list-page', async (_event, request) => {
    if (!isInitialized()) return { items: [], total: 0, counts: { open: 0, closed: 0 }, nextCursor: null };
    return listSpaceSummaries(request);
  });
  registerIpcHandler('space:get', async (_event, id) => {
    if (!isInitialized()) return null;
    return getSpace(id);
  });
  registerIpcHandler('space:events-page', async (_event, request) => {
    if (!isInitialized()) return { items: [], total: 0, nextCursor: null };
    return listSpaceEventsPage(request);
  });
  registerIpcHandler('activity:list-page', async (_event, request) => {
    if (!isInitialized()) return { items: [], total: 0, nextCursor: null };
    return listActivityPage(request);
  });

  registerIpcHandler('space:update', async (_event, id: string, updates: Partial<Pick<Space, 'description' | 'body' | 'client' | 'due_at' | 'due_at_utc' | 'status' | 'attachments'>>) => {
    return (await applySpaceUpdate(id, updates));
  });

  registerIpcHandler('space:delete', async (_event, id: string) => {
    return (await deleteSpaceFull(id));
  });

  registerIpcHandler('space:dismiss-recurrence', async (_event, id: string) => {
    (await dismissRecurrence(id));
    return true;
  });

  // Space events / timeline
  registerIpcHandler('space:events', async (_event, limit?: number) => {
    return (await listSpaceEvents(limit || 100));
  });

  registerIpcHandler('activity:stats', async (_event, windowDays?: number) => {
    if (!isInitialized()) return { days: [], totals: EMPTY_ACTIVITY_TOTALS };
    return (await getActivityStats(windowDays && windowDays > 0 ? Math.min(windowDays, 730) : undefined));
  });

  // Resolve natural language date
  registerIpcHandler('space:resolve-date', async (_event, dateText: string) => {
    return resolveDateWithAI(dateText);
  });

  // Classify user input as space vs query
  registerIpcHandler('space:classify', async (_event, text: string) => {
    if (!isInitialized()) return { type: 'space' };
    const allSpaces = (await listSpaces());
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

  registerIpcHandler('space:search', async (_event, query: string) => {
    if (!isInitialized()) return [];
    return (await searchSpaces(query));
  });

  registerIpcHandler('space:unarchive', async (_event, id: string) => {
    return (await unarchiveSpaceFull(id));
  });
}
