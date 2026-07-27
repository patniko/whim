/**
 * Type-safe wrappers around Electron IPC registration.
 *
 * These helpers enforce the contract defined in `src/shared/ipc-contract.ts`
 * so that handler signatures are checked at compile time.  The `as any` casts
 * are intentionally internal — consumers see only the typed API.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { registerIpcHandler } from './registry';
import { mirrorRendererEvent } from '../web/event-hub';
import type {
  IpcCommandChannel,
  IpcCommands,
  IpcEventChannel,
  IpcEvents,
  IpcMessageChannel,
  IpcMessages,
} from '../../shared/ipc-contract';

/**
 * Type-safe wrapper around `ipcMain.handle`.
 * Ensures the handler function signature matches the contract.
 */
export function registerHandler<C extends IpcCommandChannel>(
  channel: C,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: IpcCommands[C]['args']
  ) => IpcCommands[C]['result'] | Promise<IpcCommands[C]['result']>,
): void {
  registerIpcHandler(channel, handler as any);
}

/**
 * Type-safe wrapper around `ipcMain.on` for fire-and-forget messages.
 */
export function registerMessage<C extends IpcMessageChannel>(
  channel: C,
  handler: (
    event: Electron.IpcMainEvent,
    ...args: IpcMessages[C]['args']
  ) => void,
): void {
  ipcMain.on(channel, handler as any);
}

/**
 * Type-safe event sender — sends typed payloads to all renderer windows.
 */
export function sendToAllWindows<C extends IpcEventChannel>(
  channel: C,
  ...args: IpcEvents[C] extends void ? [] : [payload: IpcEvents[C]]
): void {
  mirrorRendererEvent(channel, ...args);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, ...args);
  }
}
