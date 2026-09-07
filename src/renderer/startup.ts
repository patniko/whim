import type { WhimAPI } from '../shared/whim-api';

/** Readiness is storage-only: optional runtime probes and indexing cannot gate capture. */
export async function waitForCaptureStorage(
  api: Pick<WhimAPI, 'getStorageStatus'>, current: () => boolean = () => true,
): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (current()) {
    const status = await api.getStorageStatus();
    if (status.state === 'ready') return;
    if (status.state === 'failed' || status.state === 'closing') {
      throw new Error(`Storage is ${status.state}; capture text has been kept.`);
    }
    if (performance.now() >= deadline) throw new Error('Storage is still opening. Try saving again shortly; text is kept.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Workspace changed during startup');
}
