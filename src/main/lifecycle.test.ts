import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
const mock = vi.hoisted(() => ({
  windows: [] as Array<{ isDestroyed: () => boolean; webContents: { id: number; getURL: () => string; send: ReturnType<typeof vi.fn> } }>,
  on: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => mock.windows }, ipcMain: { on: mock.on } }));
import { flushEditors, installLifecycleHandler } from './lifecycle';

beforeEach(() => {
  vi.useFakeTimers();
  mock.windows = [1, 2].map(id => ({
    isDestroyed: () => false,
    webContents: { id, getURL: () => 'copilot-whim://app/renderer/index.html', send: vi.fn() },
  }));
  installLifecycleHandler(async () => undefined);
});
afterEach(() => vi.useRealTimers());

describe('editor flush handshake', () => {
  function acknowledge(id: number, token: string, ok = true) {
    const listener = mock.on.mock.calls.find(call => call[0] === 'lifecycle:flush-result')![1];
    listener({ sender: { id } }, { token, ok });
  }
  it('requires the matching token from every editor before completion', async () => {
    let completed = false;
    const flush = flushEditors('quit').then(() => { completed = true; });
    const token = mock.windows[0].webContents.send.mock.calls[0][1].token;
    acknowledge(1, 'stale');
    acknowledge(99, token);
    await Promise.resolve();
    expect(completed).toBe(false);
    acknowledge(1, token);
    await Promise.resolve();
    expect(completed).toBe(false);
    acknowledge(2, token);
    await flush;
    expect(completed).toBe(true);
  });
  it('fails closed when an editor cannot save', async () => {
    const flush = flushEditors('update');
    const token = mock.windows[0].webContents.send.mock.calls[0][1].token;
    acknowledge(1, token, false);
    await expect(flush).rejects.toThrow('could not save');
  });
  it('does not treat an unresponsive editor as successfully flushed', async () => {
    const flush = flushEditors('workspace');
    const rejection = expect(flush).rejects.toThrow('did not acknowledge');
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });
});
