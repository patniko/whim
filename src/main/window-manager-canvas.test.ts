import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Multi-window electron mock ─────────────────────────────────────
// Each `new BrowserWindow()` returns a distinct window so we can exercise the
// canvas-tracking helpers (which key off `win.id` and per-window visibility).

interface MockWin {
  id: number;
  loadURL: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn<() => void>>;
  focus: ReturnType<typeof vi.fn>;
  isVisible: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  webContents: {
    send: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    isLoading: ReturnType<typeof vi.fn>;
  };
  __fire: (event: string, ...args: any[]) => void;
  __fireLoad: () => void;
}

const createdWindows: MockWin[] = [];
let nextId = 1;

function makeWindow(): MockWin {
  let visible = false;
  const eventHandlers = new Map<string, Function>();
  const wcOnce = new Map<string, Function>();
  const win: MockWin = {
    id: nextId++,
    loadURL: vi.fn(),
    show: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }),
    focus: vi.fn(),
    isVisible: vi.fn(() => visible),
    isDestroyed: vi.fn(() => false),
    setAlwaysOnTop: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 780, height: 700 })),
    setBounds: vi.fn(),
    on: vi.fn((event: string, handler: Function) => { eventHandlers.set(event, handler); }),
    once: vi.fn(),
    webContents: {
      send: vi.fn(),
      on: vi.fn(),
      once: vi.fn((event: string, handler: Function) => { wcOnce.set(event, handler); }),
      setWindowOpenHandler: vi.fn(),
      isLoading: vi.fn(() => false),
    },
    __fire: (event: string, ...args: any[]) => { eventHandlers.get(event)?.(...args); },
    __fireLoad: () => {
      wcOnce.get('did-finish-load')?.();
      ipcOnHandlers.get('window:renderer-ready')?.({ sender: win.webContents });
    },
  };
  return win;
}

const ipcOnHandlers = new Map<string, Function>();
const ipcHandleHandlers = new Map<string, Function>();

vi.mock('electron', () => {
  function MockBrowserWindow() {
    const w = makeWindow();
    createdWindows.push(w);
    return w;
  }
  (MockBrowserWindow as any).getAllWindows = () => [...createdWindows];
  (MockBrowserWindow as any).fromWebContents = (webContents: unknown) =>
    createdWindows.find((w) => w.webContents === webContents) ?? null;
  return {
    BrowserWindow: MockBrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    ipcMain: {
      on: vi.fn((channel: string, handler: Function) => { ipcOnHandlers.set(channel, handler); }),
      handle: vi.fn((channel: string, handler: Function) => { ipcHandleHandlers.set(channel, handler); }),
    },
    app: { isPackaged: false },
    shell: { openExternal: vi.fn() },
  };
});

const spaceStore = new Map<string, { description: string }>();
vi.mock('./storage', async () => ({
  ...(await import('./workspace')),
  ...(await import('./services/skill-schedule-store')),
  ...(await import('./canvas/artifact-store')),
  documentMatches: (await import('./storage-documents')).documentMatches,
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),

  getSpace: vi.fn((id: string) => spaceStore.get(id) ?? null),
}));

vi.mock('./config', () => {
  const store: Record<string, any> = { pinned: false };
  return {
    getConfigValue: vi.fn((key: string) => store[key]),
    setConfigValue: vi.fn((key: string, value: any) => { store[key] = value; }),
  };
});

import {
  registerWindowIpcHandlers,
  getOpenCanvases,
  focusCanvasWindow,
  onCanvasWindowsChanged,
} from './window-manager';

/** Open a canvas via the `canvas-window:open-new` IPC handler, fire its load,
 *  and return the freshly created mock window (now visible). */
function openCanvas(target: Record<string, unknown>): MockWin {
  const handler = ipcOnHandlers.get('canvas-window:open-new')!;
  handler({}, target);
  const win = createdWindows[createdWindows.length - 1];
  win.__fireLoad();
  return win;
}

describe('window-manager canvas helpers', () => {
  beforeEach(() => {
    registerWindowIpcHandlers('/mock/preload.js');
    spaceStore.clear();
  });

  afterEach(() => {
    // Fire each window's 'closed' handler to drop it from module-level state.
    for (const win of createdWindows) win.__fire('closed');
    createdWindows.length = 0;
    ipcOnHandlers.get('window:set-pinned')?.({}, false);
  });

  it('lists only visible canvases with a label from the target title', async () => {
    const a = openCanvas({ kind: 'space', id: 's1', title: 'Title A' });
    const b = openCanvas({ kind: 'space', id: 's2', title: 'Title B' });

    let open = (await getOpenCanvases());
    expect(open).toEqual(
      expect.arrayContaining([
        { winId: a.id, label: 'Title A' },
        { winId: b.id, label: 'Title B' },
      ]),
    );

    // Hiding a window removes it from the list.
    b.hide();
    open = (await getOpenCanvases());
    expect(open.map((c) => c.winId)).toContain(a.id);
    expect(open.map((c) => c.winId)).not.toContain(b.id);
  });

  it('falls back to the space description when the target has no title', async () => {
    spaceStore.set('s9', { description: 'Quarterly planning' });
    const win = openCanvas({ kind: 'space', id: 's9', title: '' });

    const open = (await getOpenCanvases());
    expect(open).toContainEqual({ winId: win.id, label: 'Quarterly planning' });
  });

  it('labels a page target with the page name', async () => {
    const win = openCanvas({ kind: 'page', spaceId: 's1', page: 'notes', title: 'notes' });
    const open = (await getOpenCanvases());
    expect(open).toContainEqual({ winId: win.id, label: 'notes' });
  });

  it('updates a page label from a renderer title update', async () => {
    const win = openCanvas({ kind: 'page', spaceId: 's1', page: 'notes', title: 'notes' });
    const handler = ipcOnHandlers.get('canvas-window:update-title')!;

    handler({ sender: win.webContents }, 'Derived Notes');

    expect((await getOpenCanvases())).toContainEqual({ winId: win.id, label: 'Derived Notes' });
  });

  it('focusCanvasWindow shows a hidden window and focuses it', () => {
    const win = openCanvas({ kind: 'space', id: 's1', title: 'A' });
    win.hide();
    win.show.mockClear();

    focusCanvasWindow(win.id);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it('focusCanvasWindow is a no-op for an unknown id', () => {
    const win = openCanvas({ kind: 'space', id: 's1', title: 'A' });
    win.focus.mockClear();
    focusCanvasWindow(999999);
    expect(win.focus).not.toHaveBeenCalled();
  });

  it('notifies subscribers on open, hide and close', () => {
    const cb = vi.fn();
    const unsub = onCanvasWindowsChanged(cb);

    const win = openCanvas({ kind: 'space', id: 's1', title: 'A' });
    expect(cb).toHaveBeenCalled(); // target set on load

    cb.mockClear();
    win.__fire('hide');
    expect(cb).toHaveBeenCalledTimes(1);

    cb.mockClear();
    win.__fire('closed');
    expect(cb).toHaveBeenCalledTimes(1);

    // After unsubscribe, no more notifications.
    unsub();
    cb.mockClear();
    openCanvas({ kind: 'space', id: 's2', title: 'B' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('drops a canvas from the list once closed', async () => {
    const win = openCanvas({ kind: 'space', id: 's1', title: 'A' });
    expect((await getOpenCanvases()).map((c) => c.winId)).toContain(win.id);

    win.__fire('closed');
    expect((await getOpenCanvases()).map((c) => c.winId)).not.toContain(win.id);
  });

  it('keeps canvas always-on-top independent from the side panel pin', () => {
    const win = openCanvas({ kind: 'space', id: 's1', title: 'A' });
    const setSidePanelPinned = ipcOnHandlers.get('window:set-pinned')!;
    const setCanvasPinned = ipcOnHandlers.get('canvas-window:set-always-on-top')!;

    win.setAlwaysOnTop.mockClear();
    setSidePanelPinned({}, true);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(false);

    setCanvasPinned({ sender: win.webContents }, true);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true);

    setSidePanelPinned({}, false);
    expect(win.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
  });
});
