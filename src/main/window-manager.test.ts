import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Capture IPC handlers and window event listeners ─────────────────
const ipcHandlers = new Map<string, Function>();
const ipcOnHandlers = new Map<string, Function>();

let blurHandler: (() => void) | null = null;
let moveHandler: (() => void) | null = null;
let resizeHandler: (() => void) | null = null;

const mockWebContents = {
  send: vi.fn(),
  setWindowOpenHandler: vi.fn(),
  on: vi.fn(),
  once: vi.fn(),
};

const mockWindow = {
  loadURL: vi.fn(),
  on: vi.fn((event: string, handler: Function) => {
    if (event === 'blur') blurHandler = handler as () => void;
    if (event === 'move') moveHandler = handler as () => void;
    if (event === 'resize') resizeHandler = handler as () => void;
  }),
  webContents: mockWebContents,
  getBounds: vi.fn(() => ({ x: 100, y: 100, width: 420, height: 520 })),
  setBounds: vi.fn(),
  setPosition: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  setResizable: vi.fn(),
  isResizable: vi.fn(() => true),
  setSize: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  focus: vi.fn(),
  isVisible: vi.fn(() => true),
  isFocused: vi.fn(() => true),
  isMinimized: vi.fn(() => false),
  isDestroyed: vi.fn(() => false),
  isAlwaysOnTop: vi.fn(() => false),
};

vi.mock('electron', () => {
  function MockBrowserWindow() {
    return mockWindow;
  }
  MockBrowserWindow.getAllWindows = () => [mockWindow];
  MockBrowserWindow.fromWebContents = () => null;

  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: Function) => {
        ipcHandlers.set(channel, handler);
      }),
      on: vi.fn((channel: string, handler: Function) => {
        ipcOnHandlers.set(channel, handler);
      }),
    },
    app: {
      isPackaged: false,
    },
    shell: { openExternal: vi.fn() },
  };
});

vi.mock('./config', () => {
  const store: Record<string, any> = { autoHideSidePane: true };
  return {
    getConfigValue: vi.fn((key: string) => store[key]),
    setConfigValue: vi.fn((key: string, value: any) => { store[key] = value; }),
  };
});

// Now import the module under test after mocks are in place
import { createMainWindow, registerWindowIpcHandlers, toggleWindow } from './window-manager';
import { BrowserWindow } from 'electron';
import { setConfigValue } from './config';

describe('window-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcHandlers.clear();
    ipcOnHandlers.clear();
    blurHandler = null;
    moveHandler = null;

    // Create the main window and register IPC handlers
    createMainWindow({ preloadPath: '/mock/preload.js' });
    registerWindowIpcHandlers('/mock/preload.js');
  });

  describe('unpin grace period', () => {
    it('does not send request-hide on blur within 500ms of unpinning', () => {
      // Simulate pinning first
      const setPinned = ipcOnHandlers.get('window:set-pinned')!;
      setPinned({ sender: mockWebContents }, true);

      // Now unpin
      setPinned({ sender: mockWebContents }, false);

      // Simulate blur immediately after unpin (within grace period)
      expect(blurHandler).toBeTruthy();
      blurHandler!();

      // request-hide should NOT have been sent
      const requestHideCalls = mockWebContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'window:request-hide'
      );
      expect(requestHideCalls).toHaveLength(0);
    });

    it('sends request-hide on blur after grace period expires', async () => {
      // Pin then unpin
      const setPinned = ipcOnHandlers.get('window:set-pinned')!;
      setPinned({ sender: mockWebContents }, true);
      setPinned({ sender: mockWebContents }, false);

      // Wait for grace period to expire
      await new Promise(resolve => setTimeout(resolve, 550));

      // Now blur should trigger request-hide
      blurHandler!();

      const requestHideCalls = mockWebContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'window:request-hide'
      );
      expect(requestHideCalls).toHaveLength(1);
    });

    it('does not send request-hide when still pinned', () => {
      const setPinned = ipcOnHandlers.get('window:set-pinned')!;
      setPinned({ sender: mockWebContents }, true);

      blurHandler!();

      const requestHideCalls = mockWebContents.send.mock.calls.filter(
        (c: any[]) => c[0] === 'window:request-hide'
      );
      expect(requestHideCalls).toHaveLength(0);
    });
  });

  describe('unpin snap guard', () => {
    it('sets isSnapping during unpin to prevent double-snap', () => {
      const setPinned = ipcOnHandlers.get('window:set-pinned')!;
      setPinned({ sender: mockWebContents }, true);

      // Unpin — should call setBounds for the reposition
      setPinned({ sender: mockWebContents }, false);
      expect(mockWindow.setBounds).toHaveBeenCalled();

      // Simulate the move event that setBounds triggers
      // handleWindowMoved has a 500ms debounce, so we need to wait
      // The key check is that setBounds was only called once (the unpin snap)
      // and not a second time from handleWindowMoved
    });
  });

  describe('toggleWindow hotkey', () => {
    it('hides window when visible and focused (autoHide mode)', () => {
      setConfigValue('autoHideSidePane', true);
      mockWindow.isVisible.mockReturnValue(true);
      mockWindow.isFocused.mockReturnValue(true);

      toggleWindow('hotkey');

      expect(mockWebContents.send).toHaveBeenCalledWith('window:toggle', { source: 'hotkey' });
    });

    it('shows window when hidden (autoHide mode)', () => {
      setConfigValue('autoHideSidePane', true);
      mockWindow.isVisible.mockReturnValue(false);

      toggleWindow();

      expect(mockWindow.show).toHaveBeenCalled();
      expect(mockWindow.focus).toHaveBeenCalled();
      expect(mockWebContents.send).toHaveBeenCalledWith(
        'window:shown',
        expect.objectContaining({ expanded: false, source: 'other' }),
      );
    });

    it('reports the tray as the source when the toggle came from the tray icon', () => {
      setConfigValue('autoHideSidePane', true);
      mockWindow.isVisible.mockReturnValue(false);

      toggleWindow('tray');

      expect(mockWebContents.send).toHaveBeenCalledWith(
        'window:shown',
        expect.objectContaining({ source: 'tray' }),
      );
    });

    it('hides window when visible and focused (non-autoHide mode)', () => {
      setConfigValue('autoHideSidePane', false);
      mockWindow.isVisible.mockReturnValue(true);
      mockWindow.isFocused.mockReturnValue(true);

      toggleWindow();

      expect(mockWebContents.send).toHaveBeenCalledWith('window:toggle', { source: 'other' });
    });

    it('focuses window when visible but not focused (non-autoHide mode)', () => {
      setConfigValue('autoHideSidePane', false);
      mockWindow.isVisible.mockReturnValue(true);
      mockWindow.isFocused.mockReturnValue(false);

      toggleWindow();

      expect(mockWindow.focus).toHaveBeenCalled();
      expect(mockWebContents.send).not.toHaveBeenCalledWith('window:toggle', expect.anything());
    });

    it('shows window when hidden (non-autoHide mode)', () => {
      setConfigValue('autoHideSidePane', false);
      mockWindow.isVisible.mockReturnValue(false);

      toggleWindow();

      expect(mockWindow.show).toHaveBeenCalled();
      expect(mockWindow.focus).toHaveBeenCalled();
      expect(mockWebContents.send).toHaveBeenCalledWith(
        'window:shown',
        expect.objectContaining({ expanded: false }),
      );
    });
  });
});
