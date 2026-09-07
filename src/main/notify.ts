import { BrowserWindow } from 'electron';
import { mirrorRendererEvent } from './web/event-hub';
import { isMainThread, parentPort } from 'worker_threads';
import type { StorageNotification } from './storage-contract';
import { assertWorkspaceContext } from './workspace-context';

export function notifyAllWindows(channel: string, ...args: any[]): void {
  if (!isMainThread && parentPort) {
    parentPort.postMessage({ notification: true, channel, args } satisfies StorageNotification);
    return;
  }
  assertWorkspaceContext();
  mirrorRendererEvent(channel, ...args);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}
