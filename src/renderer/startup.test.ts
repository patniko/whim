import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForCaptureStorage } from './startup';

afterEach(() => vi.useRealTimers());
describe('capture readiness', () => {
  it('does not wait for indexes, runtime probes, lists, or network', async () => {
    const api = { getStorageStatus: vi.fn().mockResolvedValue({
      state: 'ready', generation: 1, pending: 150, indexing: true,
    }) };
    await expect(waitForCaptureStorage(api)).resolves.toBe('ready');
    expect(api.getStorageStatus).toHaveBeenCalledTimes(1);
  });
  it('waits through opening and fails closed on storage failure', async () => {
    vi.useFakeTimers();
    const api = { getStorageStatus: vi.fn().mockResolvedValueOnce({ state: 'opening' })
      .mockResolvedValue({ state: 'failed' }) };
    const wait = waitForCaptureStorage(api);
    const failure = expect(wait).rejects.toThrow('Your text is still here');
    await vi.advanceTimersByTimeAsync(50);
    await failure;
  });
  it('cancels stale workspace readiness without a user-facing error', async () => {
    const api = { getStorageStatus: vi.fn() };
    await expect(waitForCaptureStorage(api, () => false)).resolves.toBe('superseded');
    expect(api.getStorageStatus).not.toHaveBeenCalled();
  });
  it.each(['ready', 'failed', 'closing'])('ignores a stale %s reply after a workspace change', async state => {
    let current = true;
    const api = { getStorageStatus: vi.fn().mockImplementation(async () => {
      current = false;
      return { state };
    }) };
    await expect(waitForCaptureStorage(api, () => current)).resolves.toBe('superseded');
  });
  it('cancels the old wait while storage is opening, leaving the new workspace free to start', async () => {
    vi.useFakeTimers();
    let current = true;
    const api = { getStorageStatus: vi.fn().mockResolvedValue({ state: 'opening' }) };
    const oldWait = waitForCaptureStorage(api, () => current);
    await vi.advanceTimersByTimeAsync(0);
    current = false;
    await vi.advanceTimersByTimeAsync(50);
    await expect(oldWait).resolves.toBe('superseded');
    api.getStorageStatus.mockResolvedValue({ state: 'ready' });
    await expect(waitForCaptureStorage(api)).resolves.toBe('ready');
  });
  it('only suppresses RPC errors when the workspace has actually changed', async () => {
    let current = true;
    const api = { getStorageStatus: vi.fn().mockImplementation(async () => {
      current = false;
      throw new Error('Workspace generation expired');
    }) };
    await expect(waitForCaptureStorage(api, () => current)).resolves.toBe('superseded');
    api.getStorageStatus.mockRejectedValue(new Error('Disconnected'));
    await expect(waitForCaptureStorage(api)).rejects.toThrow('Disconnected');
  });
});
