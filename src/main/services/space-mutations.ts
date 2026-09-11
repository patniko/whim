/**
 * Shared space mutation logic (update / delete / unarchive).
 *
 * Extracted so both the desktop IPC handlers (`space-handlers.ts`) and the web
 * remote gateway (`web/gateway.ts`) drive the exact same behavior — recurrence
 * evaluation on completion, folder archiving, AI refinement triggers, and folder
 * deletion — without duplicating the rules in two places.
 */
import { getSpace, updateSpace, deleteSpace, logSpaceEvent } from '../storage';
import type { Space } from '../../shared/types';
import { getConfigValue } from '../config';
import { scheduleAutoCommit, commitNow } from '../workspace';
import { archiveSpaceFolder, unarchiveSpaceFolder, deleteSpaceFolder } from '../storage';
import { handleRecurrence, cancelPendingRecurrence } from './recurrence';
import { processSpaceInBackground } from './space-processing';
import { observeProducer } from '../producer-tasks';
import { notifyAllWindows } from '../notify';

export type SpaceUpdates = Partial<
  Pick<Space, 'description' | 'body' | 'client' | 'due_at' | 'due_at_utc' | 'status' | 'attachments'>
>;

/** Apply an update to a space, mirroring the desktop `space:update` handler. */
export async function applySpaceUpdate(id: string, updates: SpaceUpdates): Promise<Space | null> {
  // Detect transition to 'done' for recurrence evaluation + folder archiving.
  if (updates.status === 'done') {
    const current = (await getSpace(id));
    if (current && current.status !== 'done') {
      const completedAt = new Date().toISOString();
      const updated = (await updateSpace(id, { ...updates, completed_at: completedAt }));
      if (updated) {
        (await logSpaceEvent(id, 'completed', {
          due_at: updated.due_at,
          due_at_utc: updated.due_at_utc,
          completed_at: completedAt,
        }));

        if (updated.due_at_utc || updated.due_at) {
          void observeProducer(handleRecurrence(updated, updated.updated_at));
        }

        const workspace = getConfigValue('workspace');
        if (workspace && updated.folder) {
          await commitNow(workspace);
          (await archiveSpaceFolder(workspace, updated.folder));
          scheduleAutoCommit(workspace);
        }
      }
      return updated;
    }
  }

  // If body is being set (e.g., from canvas write-then-close), trigger AI refinement.
  if (updates.body && updates.body.trim()) {
    const current = (await getSpace(id));
    if (current && (!current.description || current.description === '' || current.description === current.body)) {
      const updated = (await updateSpace(id, updates));
      if (updated) {
        (await processSpaceInBackground(id, updates.body, updated.updated_at));
      }
      return updated;
    }
  }

  return (await updateSpace(id, updates));
}

/** Delete a space + its folder, mirroring the desktop `space:delete` handler. */
export async function deleteSpaceFull(id: string): Promise<boolean> {
  const current = (await getSpace(id));
  cancelPendingRecurrence(id);
  const result = (await deleteSpace(id));
  const workspace = getConfigValue('workspace');
  if (workspace) {
    if (current?.folder) {
      (await deleteSpaceFolder(workspace, current.folder));
    }
    scheduleAutoCommit(workspace);
  }
  if (result) {
    // Tell every window (e.g. a canvas popout editing this space) so they
    // discard in-memory content instead of later failing to save it back to
    // a folder that no longer exists.
    notifyAllWindows('space:deleted', { spaceId: id });
  }
  return result;
}

/** Restore a completed space back to active, mirroring `space:unarchive`. */
export async function unarchiveSpaceFull(id: string): Promise<Space | null> {
  const current = (await getSpace(id));
  if (!current || current.status !== 'done') return null;

  const updated = (await updateSpace(id, { status: 'captured', completed_at: null }));
  if (updated) {
    (await logSpaceEvent(id, 'unarchived'));

    const workspace = getConfigValue('workspace');
    if (workspace && updated.folder) {
      await commitNow(workspace);
      (await unarchiveSpaceFolder(workspace, updated.folder));
      scheduleAutoCommit(workspace);
    }
  }
  return updated;
}
