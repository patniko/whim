import { evaluateRecurrence } from '../ai';
import { updateSpaceCAS, logSpaceEvent } from '../storage';
import { notifyAllWindows } from '../notify';
import { Space, RecurrenceResult } from '../../shared/types';

// Track in-flight recurrence evaluations so we can cancel them
const pendingRecurrences = new Map<string, { result: RecurrenceResult; version: string; timer: ReturnType<typeof setTimeout> }>();

export async function handleRecurrence(space: Space, version: string): Promise<void> {
  try {
    const result = await evaluateRecurrence({
      raw_text: space.raw_text,
      description: space.description,
      due_at: space.due_at,
      due_at_utc: space.due_at_utc,
      completed_at: space.completed_at!,
    });

    if (!result.should_recur) {
      notifyAllWindows('space:recurrence', space.id, result);
      return;
    }

    // Send result to renderer immediately for preview
    notifyAllWindows('space:recurrence', space.id, result);

    // Start undo window — apply recurrence after 5 seconds
    const timer = setTimeout(async () => {
      (await applyRecurrence(space.id, version, result));
      pendingRecurrences.delete(space.id);
    }, 5000);

    pendingRecurrences.set(space.id, { result, version, timer });
  } catch (err) {
    console.error('[recurrence] Evaluation failed:', err);
  }
}

export async function applyRecurrence(spaceId: string, expectedVersion: string, result: RecurrenceResult): Promise<void> {
  const updated = (await updateSpaceCAS(spaceId, expectedVersion, {
    status: 'captured',
    due_at: result.next_due,
    due_at_utc: result.next_due_utc,
    recurrence: JSON.stringify(result),
  }));

  if (updated) {
    (await logSpaceEvent(spaceId, 'recycled', {
      due_at: result.next_due,
      due_at_utc: result.next_due_utc,
      recurrence_json: JSON.stringify(result),
    }));
    notifyAllWindows('space:recurrence-applied', spaceId);
    console.log(`[recurrence] Applied for ${spaceId}: next due ${result.next_due}`);
  } else {
    console.log(`[recurrence] CAS failed for ${spaceId} — space was modified`);
  }
}

export async function dismissRecurrence(spaceId: string): Promise<void> {
  const pending = pendingRecurrences.get(spaceId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRecurrences.delete(spaceId);
    (await logSpaceEvent(spaceId, 'recurrence_dismissed', {
      recurrence_json: JSON.stringify(pending.result),
    }));
    console.log(`[recurrence] Dismissed for ${spaceId}`);
  }
}

export function cancelPendingRecurrence(spaceId: string): void {
  const pending = pendingRecurrences.get(spaceId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingRecurrences.delete(spaceId);
  }
}

export function hasPendingRecurrence(spaceId: string): boolean {
  return pendingRecurrences.has(spaceId);
}
