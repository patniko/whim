import { BrowserWindow, ipcMain } from 'electron';
import { randomUUID } from 'crypto';

import type { EditorFlushRequest, EditorFlushResult } from '../shared/ipc-contract';
export type ShutdownRequest = EditorFlushRequest;
export type ShutdownAcknowledgement = EditorFlushResult;

let installed = false;
let shutdown: Promise<void> | undefined;
let prepare: (() => Promise<void>) | undefined;
let pending: {
  token: string;
  windows: Set<number>;
  resolve: () => void;
  reject: (error: Error) => void;
} | undefined;

export function installLifecycleHandler(cleanup: () => Promise<void>): void {
  prepare = cleanup;
  if (installed) return;
  installed = true;
  ipcMain.on('lifecycle:flush-result', (event, result: ShutdownAcknowledgement) => {
    if (!pending || result?.token !== pending.token || !pending.windows.has(event.sender.id)) return;
    if (result.ok !== true) {
      pending.reject(new Error(result.error || 'An editor could not save; shutdown cancelled'));
      return;
    }
    pending.windows.delete(event.sender.id);
    if (!pending.windows.size) pending.resolve();
  });
}

/** No timeout fallback: failed/missing acknowledgements must never discard dirty text. */
export async function flushEditors(reason: ShutdownRequest['reason'], targets = BrowserWindow.getAllWindows()): Promise<() => void> {
  if (pending) throw new Error('An editor flush is already in progress');
  const windows = targets.filter(win =>
    !win.isDestroyed() && win.webContents.getURL().startsWith('copilot-whim://'));
  if (!windows.length) return () => {};
  const token = randomUUID();
  const release = () => {
    for (const win of windows) {
      if (!win.isDestroyed()) win.webContents.send('lifecycle:flush-released', token);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Editors did not acknowledge saving; operation cancelled')), 15_000);
      pending = {
        token, windows: new Set(windows.map(win => win.webContents.id)),
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      };
      for (const win of windows) win.webContents.send('lifecycle:flush-request', { token, reason } satisfies ShutdownRequest);
    });
    return release;
  } catch (error) {
    release();
    throw error;
  } finally {
    pending = undefined;
  }
}

export function prepareShutdown(reason: 'quit' | 'update'): Promise<void> {
  if (shutdown) return shutdown;
  shutdown = (async () => {
    if (!prepare) throw new Error('Shutdown coordinator not installed');
    const release = await flushEditors(reason);
    try { await prepare(); } catch (error) { release(); throw error; }
  })().catch(error => {
    shutdown = undefined;
    throw error;
  });
  return shutdown;
}
