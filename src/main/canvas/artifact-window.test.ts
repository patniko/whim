import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockWin {
  id: number;
  loadURL: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  isVisible: () => boolean;
  isFocused: () => boolean;
  isDestroyed: () => boolean;
  on: ReturnType<typeof vi.fn>;
  webContents: {
    reload: ReturnType<typeof vi.fn>;
    setWindowOpenHandler: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    session: {
      setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    };
  };
  __options: any;
  __fire: (event: string, ...args: any[]) => void;
  __fireWc: (event: string, ...args: any[]) => void;
}

const createdWindows: MockWin[] = [];
let nextId = 1;
const openExternal = vi.fn();

vi.mock('electron', () => ({
  shell: { openExternal: (...args: any[]) => openExternal(...args) },
  BrowserWindow: class {
    constructor(options: any) {
      const handlers = new Map<string, Function>();
      const wcHandlers = new Map<string, Function>();
      let visible = false;
      let focused = false;
      let destroyed = false;
      const win: MockWin = {
        id: nextId++,
        loadURL: vi.fn(),
        show: vi.fn(() => { visible = true; }),
        focus: vi.fn(() => { focused = true; }),
        close: vi.fn(() => {
          destroyed = true;
          handlers.get('closed')?.();
        }),
        setTitle: vi.fn(),
        isVisible: () => visible,
        isFocused: () => visible && focused,
        isDestroyed: () => destroyed,
        on: vi.fn((event: string, handler: Function) => { handlers.set(event, handler); }),
        webContents: {
          reload: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          on: vi.fn((event: string, handler: Function) => { wcHandlers.set(event, handler); }),
          session: {
            setPermissionRequestHandler: vi.fn(),
            setPermissionCheckHandler: vi.fn(),
            on: vi.fn((event: string, handler: Function) => { wcHandlers.set(`session:${event}`, handler); }),
          },
        },
        __options: options,
        __fire: (event: string, ...args: any[]) => handlers.get(event)?.(...args),
        __fireWc: (event: string, ...args: any[]) => wcHandlers.get(event)?.(...args),
      };
      createdWindows.push(win);
      return win as unknown as this;
    }
  },
}));

import {
  openArtifactWindow,
  reloadArtifactWindow,
  setArtifactWindowTitle,
  getOpenArtifactWindows,
  focusArtifactWindow,
  findArtifactWindowByInstance,
  closeArtifactWindow,
  closeAllArtifactWindows,
  onArtifactWindowClosed,
  onArtifactWindowsChanged,
  resetArtifactWindowsForTests,
} from './artifact-window';
import { ARTIFACT_PARTITION } from './artifact-protocol';

const KEY = { spaceId: 'space-1', artifactId: 'open-questions' };

beforeEach(() => {
  createdWindows.length = 0;
  nextId = 1;
  openExternal.mockClear();
  resetArtifactWindowsForTests();
});

describe('artifact window hardening', () => {
  it('creates the window with no preload and no node access', () => {
    openArtifactWindow({ ...KEY, title: 'Open questions' });

    const prefs = createdWindows[0].__options.webPreferences;
    expect(prefs.preload).toBeUndefined();
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webviewTag).toBe(false);
    expect(prefs.partition).toBe(ARTIFACT_PARTITION);
  });

  it('loads the artifact from its own origin', () => {
    openArtifactWindow(KEY);
    expect(createdWindows[0].loadURL).toHaveBeenCalledWith(
      'whim-artifact://space/space-1/open-questions/index.html',
    );
  });

  it('denies popups and sends web links to the system browser', () => {
    openArtifactWindow(KEY);
    const handler = createdWindows[0].webContents.setWindowOpenHandler.mock.calls[0][0];

    expect(handler({ url: 'https://github.com/x/y' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://github.com/x/y');

    openExternal.mockClear();
    expect(handler({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('blocks navigation away from the artifact origin, and only opens links the user can see', () => {
    openArtifactWindow({ ...KEY, focus: true });
    const win = createdWindows[0];
    const event = { preventDefault: vi.fn() };

    win.__fireWc('will-navigate', event, 'https://evil.example');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://evil.example');

    const sameOrigin = { preventDefault: vi.fn() };
    win.__fireWc('will-navigate', sameOrigin, 'whim-artifact://space/space-1/open-questions/index.html');
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
  });

  it('does not launch the browser from a window the user is not looking at', () => {
    // Never shown: nothing the user did can have caused this navigation, so it
    // is the page deciding what the user sees.
    openArtifactWindow({ ...KEY, focus: false });
    const win = createdWindows[0];
    const event = { preventDefault: vi.fn() };

    win.__fireWc('will-navigate', event, 'https://evil.example');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('never hands a non-web scheme to the browser', () => {
    openArtifactWindow({ ...KEY, focus: true });
    const win = createdWindows[0];

    win.__fireWc('will-navigate', { preventDefault: vi.fn() }, 'file:///etc/passwd');
    win.__fireWc('will-navigate', { preventDefault: vi.fn() }, 'javascript:alert(1)');

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('blocks redirects and downloads and denies permissions', () => {
    openArtifactWindow(KEY);
    const win = createdWindows[0];

    const redirect = { preventDefault: vi.fn() };
    win.__fireWc('will-redirect', redirect);
    expect(redirect.preventDefault).toHaveBeenCalled();

    const download = { preventDefault: vi.fn() };
    win.__fireWc('session:will-download', download);
    expect(download.preventDefault).toHaveBeenCalled();

    const permissionCb = vi.fn();
    win.webContents.session.setPermissionRequestHandler.mock.calls[0][0](null, 'media', permissionCb);
    expect(permissionCb).toHaveBeenCalledWith(false);
    expect(win.webContents.session.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
  });
});

describe('artifact window lifecycle', () => {
  it('reuses the window for the same artifact instead of stacking duplicates', () => {
    openArtifactWindow({ ...KEY, title: 'First' });
    const second = openArtifactWindow({ ...KEY, title: 'Second' });

    expect(createdWindows).toHaveLength(1);
    expect(second.title).toBe('Second');
    expect(createdWindows[0].setTitle).toHaveBeenCalledWith('Second');
  });

  it('opens separate windows for different artifacts', () => {
    openArtifactWindow(KEY);
    openArtifactWindow({ spaceId: 'space-1', artifactId: 'other' });
    expect(createdWindows).toHaveLength(2);
  });

  it('does not show or focus when focus is false', () => {
    openArtifactWindow({ ...KEY, focus: false });
    expect(createdWindows[0].show).not.toHaveBeenCalled();
    expect(createdWindows[0].focus).not.toHaveBeenCalled();
    // A silently created window is not in the tray list until it is shown.
    expect(getOpenArtifactWindows()).toHaveLength(0);
  });

  it('shows and focuses by default, and appears in the tray list', () => {
    openArtifactWindow({ ...KEY, title: 'Open questions' });
    expect(createdWindows[0].show).toHaveBeenCalled();
    expect(getOpenArtifactWindows()).toEqual([
      { winId: 1, spaceId: 'space-1', artifactId: 'open-questions', title: 'Open questions' },
    ]);
  });

  it('focuses an existing hidden window on reopen', () => {
    openArtifactWindow({ ...KEY, focus: false });
    openArtifactWindow({ ...KEY, focus: true });
    expect(createdWindows[0].show).toHaveBeenCalled();
    expect(createdWindows[0].focus).toHaveBeenCalled();
  });

  it('reloads an open window after a republish', () => {
    openArtifactWindow(KEY);
    expect(reloadArtifactWindow(KEY)).toBe(true);
    expect(createdWindows[0].webContents.reload).toHaveBeenCalled();
    expect(reloadArtifactWindow({ spaceId: 'space-1', artifactId: 'missing' })).toBe(false);
  });

  it('updates the title on a status change', () => {
    openArtifactWindow({ ...KEY, title: 'Open questions' });
    setArtifactWindowTitle(KEY, 'Open questions — 7 found');
    expect(createdWindows[0].setTitle).toHaveBeenLastCalledWith('Open questions — 7 found');
    expect(getOpenArtifactWindows()[0].title).toBe('Open questions — 7 found');
  });

  it('tracks the bound canvas instance', () => {
    openArtifactWindow({ ...KEY, instanceId: 'inst-1' });
    expect(findArtifactWindowByInstance('inst-1')?.artifactId).toBe('open-questions');
    expect(findArtifactWindowByInstance('nope')).toBeNull();
  });

  it('notifies on user close so the session can be told', () => {
    const closed = vi.fn();
    onArtifactWindowClosed(closed);
    openArtifactWindow({ ...KEY, instanceId: 'inst-1' });

    createdWindows[0].__fire('closed');

    expect(closed).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 'space-1', artifactId: 'open-questions', instanceId: 'inst-1' }),
    );
  });

  it('does not echo a close back when the session initiated it', () => {
    const closed = vi.fn();
    onArtifactWindowClosed(closed);
    openArtifactWindow(KEY);

    expect(closeArtifactWindow(KEY, false)).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  });

  it('notifies when whim closes the window on the user behalf', () => {
    const closed = vi.fn();
    onArtifactWindowClosed(closed);
    openArtifactWindow(KEY);

    expect(closeArtifactWindow(KEY)).toBe(true);
    expect(closed).toHaveBeenCalled();
  });

  it('closes every window on workspace switch', () => {
    openArtifactWindow(KEY);
    openArtifactWindow({ spaceId: 'space-2', artifactId: 'other' });

    closeAllArtifactWindows();

    expect(getOpenArtifactWindows()).toHaveLength(0);
    expect(createdWindows[0].close).toHaveBeenCalled();
    expect(createdWindows[1].close).toHaveBeenCalled();
  });

  it('emits change events for tray refreshes', () => {
    const onChange = vi.fn();
    onArtifactWindowsChanged(onChange);
    openArtifactWindow(KEY);
    expect(onChange).toHaveBeenCalled();
  });

  it('focuses by window id', () => {
    const opened = openArtifactWindow({ ...KEY, focus: false });
    focusArtifactWindow(opened.winId);
    expect(createdWindows[0].focus).toHaveBeenCalled();
  });
});
