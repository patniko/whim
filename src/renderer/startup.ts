import type { WhimAPI } from '../shared/whim-api';

/** Readiness is storage-only: optional runtime probes and indexing cannot gate capture. */
export async function waitForCaptureStorage(
  api: Pick<WhimAPI, 'getStorageStatus'>, current: () => boolean = () => true,
): Promise<'ready' | 'superseded'> {
  const deadline = performance.now() + 30_000;
  while (current()) {
    let status;
    try {
      status = await api.getStorageStatus();
    } catch (error) {
      if (!current()) return 'superseded';
      throw error;
    }
    // A reply from the old workspace must not enable capture in the new one.
    if (!current()) return 'superseded';
    if (status.state === 'ready') return 'ready';
    if (status.state === 'failed' || status.state === 'closing') {
      throw new Error("Saving isn't available right now. Your text is still here; please try again shortly.");
    }
    if (performance.now() >= deadline) throw new Error('Your workspace is taking longer to open. Your text is still here; please try again shortly.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return 'superseded';
}
