import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers = new Map<string, Function>();
const listeners = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, handler: Function) => {
      listeners.set(channel, handler);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

import { registerHandler, registerMessage, sendToAllWindows } from './typed-handler';
import { ipcMain, BrowserWindow } from 'electron';

describe('typed-handler', () => {
  beforeEach(() => {
    handlers.clear();
    listeners.clear();
    vi.clearAllMocks();
  });

  describe('registerHandler', () => {
    it('registers a handler on ipcMain.handle', () => {
      const handler = vi.fn(async (_event) => []);
      registerHandler('space:list', handler);

      expect(ipcMain.handle).toHaveBeenCalledWith('space:list', expect.any(Function));
      expect(handlers.has('space:list')).toBe(true);
    });

    it('registers a handler that receives typed args', () => {
      const handler = vi.fn(async (_event, id: string) => true);
      registerHandler('space:delete', handler);

      expect(ipcMain.handle).toHaveBeenCalledWith('space:delete', expect.any(Function));
    });
  });

  describe('registerMessage', () => {
    it('registers a listener on ipcMain.on', () => {
      const handler = vi.fn();
      registerMessage('window:hide', handler);

      expect(ipcMain.on).toHaveBeenCalledWith('window:hide', expect.any(Function));
      expect(listeners.has('window:hide')).toBe(true);
    });

    it('registers a message handler with typed args', () => {
      const handler = vi.fn((_event, pinned: boolean) => {});
      registerMessage('window:set-pinned', handler);

      expect(ipcMain.on).toHaveBeenCalledWith('window:set-pinned', expect.any(Function));
    });
  });

  describe('sendToAllWindows', () => {
    it('sends to all browser windows', () => {
      const mockSend = vi.fn();
      const mockWindow = { webContents: { send: mockSend } };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow as any]);

      sendToAllWindows('agent:completed', { agentId: 'a1', summary: 'done' });

      expect(mockSend).toHaveBeenCalledWith('agent:completed', { agentId: 'a1', summary: 'done' });
    });

    it('sends void events with no payload', () => {
      const mockSend = vi.fn();
      const mockWindow = { webContents: { send: mockSend } };
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([mockWindow as any]);

      sendToAllWindows('workspace:committed');

      expect(mockSend).toHaveBeenCalledWith('workspace:committed');
    });

    it('sends to multiple windows', () => {
      const send1 = vi.fn();
      const send2 = vi.fn();
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { webContents: { send: send1 } } as any,
        { webContents: { send: send2 } } as any,
      ]);

      const payload = { side: 'right', expanded: false, source: 'hotkey' } as const;
      sendToAllWindows('window:shown', payload);

      expect(send1).toHaveBeenCalledWith('window:shown', payload);
      expect(send2).toHaveBeenCalledWith('window:shown', payload);
    });
  });
});
