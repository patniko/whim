/*
 * Electron's bridge into the renderer.
 *
 * The API surface itself lives in `src/shared/whim-api.ts` so the web remote
 * can expose exactly the same one. All that remains here is the Electron-
 * specific half: satisfying the transport with `ipcRenderer`, and handing the
 * result across the context bridge.
 */
import { createWhimAPI, type IpcTransport } from '../shared/whim-api';

export type { WhimAPI, SubagentAPI, IpcTransport } from '../shared/whim-api';

const { contextBridge, ipcRenderer } = require('electron');

const transport: IpcTransport = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
  platform: process.platform,
};

contextBridge.exposeInMainWorld('whimAPI', createWhimAPI(transport));

// Expose platform info so the renderer can apply platform-adaptive styling
contextBridge.exposeInMainWorld('__platform', process.platform);
