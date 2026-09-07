import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForCaptureStorage } from './startup';

afterEach(() => vi.useRealTimers());
describe('capture readiness', () => {
  it('does not wait for indexes, runtime probes, lists, or network', async () => {
    const api = { getStorageStatus: vi.fn().mockResolvedValue({
      state: 'ready', generation: 1, pending: 150, indexing: true,
    }) };
    await waitForCaptureStorage(api);
    expect(api.getStorageStatus).toHaveBeenCalledTimes(1);
  });
  it('waits through opening and fails closed on storage failure', async () => {
    vi.useFakeTimers();
    const api = { getStorageStatus: vi.fn().mockResolvedValueOnce({ state: 'opening' })
      .mockResolvedValue({ state: 'failed' }) };
    const wait = waitForCaptureStorage(api);
    const failure = expect(wait).rejects.toThrow('text has been kept');
    await vi.advanceTimersByTimeAsync(50);
    await failure;
  });
  it('rejects stale workspace readiness', async () => {
    const api = { getStorageStatus: vi.fn() };
    await expect(waitForCaptureStorage(api, () => false)).rejects.toThrow('Workspace changed');
    expect(api.getStorageStatus).not.toHaveBeenCalled();
  });
});
