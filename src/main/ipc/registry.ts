/**
 * A record of every command handler the app registers.
 *
 * The web gateway used to re-implement handlers that already existed for the
 * desktop. That is a treadmill with a guaranteed ending: the two copies drift,
 * and every desktop feature has to be hand-ported before a browser can use it.
 * Commit 7af6de7 ("harden remote web and workspace parity") exists purely
 * because that drift already happened once.
 *
 * Now that the browser runs the *real* renderer, the renderer calls every
 * method the desktop does, and re-implementing ~150 handlers is not a plan.
 * So registration goes through here, the handler is recorded as it is
 * installed, and the gateway dispatches to the same function the desktop
 * calls. There is only one implementation of any command, and a new desktop
 * feature reaches the browser without anyone porting it.
 *
 * `ipcMain.handle` is still what actually runs for the desktop; this only
 * observes. Registering directly with `ipcMain.handle` is not an error — it
 * just means the command is invisible to the web remote, which `registry.test`
 * asserts is never true of a channel classified `allow`.
 */

import { ipcMain, type IpcMainInvokeEvent } from 'electron';

type AnyHandler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;

const handlers = new Map<string, AnyHandler>();

/**
 * Register a command handler for both transports.
 *
 * Drop-in replacement for `ipcMain.handle`.
 */
export function registerIpcHandler(channel: string, handler: AnyHandler): void {
  handlers.set(channel, handler);
  ipcMain.handle(channel, handler);
}

export function hasRegisteredHandler(channel: string): boolean {
  return handlers.has(channel);
}

export function registeredHandlerChannels(): string[] {
  return [...handlers.keys()];
}

/**
 * Call a registered handler outside of Electron IPC.
 *
 * The `event` argument is the one piece that cannot be honest here: there is
 * no `WebContents` behind a browser request. Handlers that genuinely need it
 * are window- and dialog-bound (`dialog:select-folder`, `workspace:select`,
 * `canvas-window:*`), and all of them are classified `desktop-only`, so they
 * never reach this path. Passing a stub rather than a fake `WebContents` keeps
 * that assumption loud: if one ever does get here, it throws a clear error
 * instead of silently acting on the wrong window.
 */
export async function callRegisteredHandler(channel: string, args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return handler(nonElectronInvokeEvent(channel), ...args);
}

function nonElectronInvokeEvent(channel: string): IpcMainInvokeEvent {
  const unavailable = (): never => {
    throw new Error(
      `Handler for "${channel}" needs the calling window, which does not exist for a web remote request. ` +
        'Classify the channel desktop-only in web-access.ts, or give it a window-independent implementation.',
    );
  };
  return new Proxy({} as IpcMainInvokeEvent, {
    get: unavailable,
    has: unavailable,
  });
}
