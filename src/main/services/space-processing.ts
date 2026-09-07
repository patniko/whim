import { parseSpaceWithAI } from '../ai';
import { updateSpaceCAS } from '../storage';
import { getConfigValue } from '../config';
import { scheduleAutoCommit } from '../workspace';
import { notifyAllWindows } from '../notify';
import { searchForRecall } from './recall';
import { observeProducer } from '../producer-tasks';

export async function processSpaceInBackground(id: string, body: string, createdVersion: string): Promise<void> {
  return observeProducer(processSpace(id, body, createdVersion));
}

async function processSpace(id: string, body: string, createdVersion: string): Promise<void> {
  try {
    const parsed = await parseSpaceWithAI(body);
    // CAS: only apply AI results if space hasn't been edited since creation
    (await updateSpaceCAS(id, createdVersion, {
      client: parsed.client,
      due_at: parsed.due_at,
      due_at_utc: parsed.due_at_utc,
    }));
    notifyAllWindows('space:processed', id);

    const workspace = getConfigValue('workspace');
    if (workspace) scheduleAutoCommit(workspace);

    // After refinement, search for similar past spaces (recall)
    (await searchForRecall(id, parsed.description));
  } catch (err) {
    console.error('[space-processing] Background processing failed:', err);
  }
}
