import { BrowserWindow, screen, ipcMain, shell, app } from 'electron';
import { EventEmitter } from 'events';
import { getConfigValue, setConfigValue, type SnapPosition } from './config';
import { getSpace } from './database';
import * as fs from 'fs';
import * as nodePath from 'path';

function getWindowIconPath(): string | undefined {
  if (process.platform === 'darwin') return undefined;
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'copilot.png';
  if (app.isPackaged) {
    return nodePath.join(process.resourcesPath, 'assets', iconName);
  }
  return nodePath.join(__dirname, '..', '..', 'src', 'assets', iconName);
}

// ── Geometry constants ───────────────────────────────────
const WINDOW_WIDTH = 420;
const WINDOW_HEIGHT = 520;
const EXPANDED_WIDTH = 720;
const EXPANDED_HEIGHT = 700;
const SNAP_MARGIN = 12;
const CANVAS_WIDTH = 780;
const CANVAS_HEIGHT = 700;

// ── Geometry constants (settings window) ─────────────────
const SETTINGS_WIDTH = 900;
const SETTINGS_HEIGHT = 680;

// ── Module state ─────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let canvasWindow: BrowserWindow | null = null;
let canvasWindowAllowClose = false;
const canvasWindows = new Set<BrowserWindow>();
const canvasUserPinned = new WeakSet<BrowserWindow>();
// Last `CanvasTarget`-like payload sent to each canvas window, keyed by
// `win.id`. Used to label open canvases in the tray menu (canvas windows
// don't set an OS/document title). Resolved lazily so labels stay fresh.
const canvasTargets = new Map<number, CanvasTargetLike>();
// Fires whenever the set of open/visible canvases — or a canvas's target —
// changes, so the tray menu can rebuild. See `onCanvasWindowsChanged`.
const canvasChangeEmitter = new EventEmitter();
let settingsWindow: BrowserWindow | null = null;
let settingsWindowAllowClose = false;
let isExpanded = false;
let isSnapping = false;
// True while we are programmatically changing the main window bounds. Used to
// distinguish our own setBounds() calls from genuine user drag-resize/move so
// that the resize-persist and snap-on-move handlers ignore the former. Without
// this, transparent+resizable+frameless windows on Windows creep a few px on
// every setBounds, and the move/resize listeners feed that back into another
// setBounds — an endless slow-growth loop.
let programmaticBounds = false;
let clearProgrammaticBoundsTimer: ReturnType<typeof setTimeout> | null = null;
let showTimestamp = 0;
let unpinTimestamp = 0;
let blurHideTimer: ReturnType<typeof setTimeout> | null = null;
let storedPreloadPath: string = '';

// ── Window stacking policy ──────────────────────────────
// Centralized helpers so every callsite agrees on when a window is alwaysOnTop.

function shouldMainBeOnTop(): boolean {
  return getConfigValue('pinned') || getConfigValue('autoHideSidePane');
}

function shouldBlurHide(): boolean {
  return getConfigValue('autoHideSidePane') && !getConfigValue('pinned');
}

function shouldCanvasBeOnTop(win: BrowserWindow): boolean {
  return getConfigValue('pinned') || canvasUserPinned.has(win);
}

// ── Canvas target tracking (for the tray menu) ───────────
// Canvas windows render different "targets" (a space, a page, a file, …) but
// never set an OS/document title, so the main process tracks the last target
// sent to each window and derives a human label on demand.

type CanvasTargetLike = {
  kind?: string;
  id?: string;
  title?: string;
  page?: string;
  spaceId?: string;
  filePath?: string;
};

/** Send a load-target to a canvas window and remember it for tray labelling. */
function sendCanvasTarget(win: BrowserWindow, target: CanvasTargetLike): void {
  if (win.isDestroyed()) return;
  canvasTargets.set(win.id, target);
  win.webContents.send('canvas-window:load-target', target);
  emitCanvasChange();
}

function emitCanvasChange(): void {
  canvasChangeEmitter.emit('change');
}

/** Derive a human-readable label for a canvas window from its current target. */
function resolveCanvasLabel(winId: number): string {
  const target = canvasTargets.get(winId);
  if (!target) return 'Canvas';
  if (typeof target.title === 'string' && target.title.trim()) return target.title.trim();
  if (target.kind === 'space' && target.id) {
    try {
      const space = getSpace(target.id);
      if (space?.description?.trim()) return space.description.trim();
    } catch { /* DB may not be ready */ }
  }
  if (target.kind === 'page' && target.page) return String(target.page);
  return 'Canvas';
}

/** Currently *visible* canvas windows, with a label for each. Used by the tray. */
export function getOpenCanvases(): { winId: number; label: string }[] {
  const result: { winId: number; label: string }[] = [];
  for (const win of canvasWindows) {
    if (win.isDestroyed() || !win.isVisible()) continue;
    result.push({ winId: win.id, label: resolveCanvasLabel(win.id) });
  }
  return result;
}

/** Show (if hidden) and focus the canvas window with the given id. */
export function focusCanvasWindow(winId: number): void {
  for (const win of canvasWindows) {
    if (win.id === winId && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.focus();
      return;
    }
  }
}

/** Subscribe to canvas open/close/show/hide/target changes. Returns unsubscribe. */
export function onCanvasWindowsChanged(cb: () => void): () => void {
  canvasChangeEmitter.on('change', cb);
  return () => { canvasChangeEmitter.off('change', cb); };
}

export interface OpenAgentChatData {
  agentId: string;
  agentPrompt: string;
  agentStatus: string;
  agentSource?: 'sdk' | 'cli' | 'cca';
  spaceId?: string;
}

/**
 * Reveal the main window (if hidden) and open the given agent's chat in it.
 * Shared by the cross-window `main-window:open-agent-chat` IPC handler and the
 * tray menu, so both behave identically.
 */
export function openAgentChatInMainWindow(data: OpenAgentChatData): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('main-window:open-agent-chat', data);
}

/** Apply the stacking policy to the main window and all canvas windows. */
function applyStackingPolicy(): void {
  if (mainWindow && !mainWindow.isDestroyed() && !isExpanded) {
    mainWindow.setAlwaysOnTop(shouldMainBeOnTop());
  }
  for (const win of canvasWindows) {
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(shouldCanvasBeOnTop(win));
    }
  }
}

function cancelBlurTimer(): void {
  if (blurHideTimer) { clearTimeout(blurHideTimer); blurHideTimer = null; }
}

/**
 * Apply bounds to the main window without triggering the Windows
 * transparent-window growth bug or the snap/resize-persist feedback loops.
 *
 * On Windows a frameless + transparent + resizable BrowserWindow grows a few
 * pixels on every setBounds() because Chromium miscalculates the non-client
 * (DWM) area. To neutralise it we temporarily make the window non-resizable
 * around the setBounds, then force the exact pixel size with setSize, then
 * restore resizability so the user can still drag-resize.
 *
 * While this runs, `programmaticBounds` is set so the `move` (snap) and
 * `resize` (persist) listeners ignore the change and don't feed it back into
 * another setBounds.
 */
function setMainBounds(
  win: BrowserWindow,
  bounds: { x: number; y: number; width: number; height: number },
  animate: boolean,
): void {
  if (win.isDestroyed()) return;
  programmaticBounds = true;

  if (process.platform === 'win32') {
    // Windows-only: neutralise the transparent-window growth bug. Make the
    // window non-resizable around the change, force the exact pixel size, then
    // restore resizability so the user can still drag-resize.
    const wasResizable = win.isResizable();
    if (wasResizable) win.setResizable(false);
    win.setBounds(bounds, animate);
    win.setSize(bounds.width, bounds.height, animate);
    if (wasResizable) win.setResizable(true);
  } else {
    // Other platforms don't exhibit the growth bug; a plain setBounds avoids
    // stacking a second (setSize) animation on top of the setBounds animation.
    win.setBounds(bounds, animate);
  }

  // Release the guard after the move/resize events emitted by this change have
  // been delivered (they can fire slightly asynchronously). Until then the
  // snap/persist listeners treat the change as ours and ignore it.
  if (clearProgrammaticBoundsTimer) clearTimeout(clearProgrammaticBoundsTimer);
  clearProgrammaticBoundsTimer = setTimeout(() => {
    programmaticBounds = false;
    clearProgrammaticBoundsTimer = null;
  }, 200);
}

// ── Public API ───────────────────────────────────────────

export interface WindowManagerOptions {
  preloadPath: string;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Create and return the main BrowserWindow. Stores reference internally. */
export function createMainWindow(options: WindowManagerOptions): BrowserWindow {
  const iconPath = getWindowIconPath();
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: shouldMainBeOnTop(),
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load via custom protocol so Web Speech API works (needs a real origin, not file://)
  win.loadURL('copilot-whim://app/renderer/index.html');
  attachBlurHide(win);
  attachResizePersist(win);
  attachExternalLinkHandler(win);

  mainWindow = win;

  return win;
}

/** Called when the autoHideSidePane setting changes at runtime. */
export function onAutoHideSidePaneChanged(): void {
  cancelBlurTimer();
  applyStackingPolicy();
}

/** Toggle the main window: show (full-height edge strip) or delegate hide to renderer. */
export function toggleWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const autoHide = getConfigValue('autoHideSidePane');

  if (!autoHide) {
    // Non-auto-hide mode: toggle the window visibility
    if (mainWindow.isVisible()) {
      if (mainWindow.isFocused()) {
        // Visible and focused — hide via renderer slide-out
        mainWindow.webContents.send('window:toggle');
      } else {
        // Visible but behind other windows — bring to front
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    } else {
      const cursorPoint = screen.getCursorScreenPoint();
      const display = screen.getDisplayNearestPoint(cursorPoint);
      const { x, y, width, height } = display.workArea;

      const snap = getConfigValue('snapPosition') || 'bottom-right';
      const isLeft = snap.includes('left');
      const winWidth = getConfigValue('windowWidth') || WINDOW_WIDTH;
      const winX = isLeft ? x + SNAP_MARGIN : x + width - winWidth - SNAP_MARGIN;
      const winY = y + SNAP_MARGIN;
      const winHeight = height - SNAP_MARGIN * 2;

      setMainBounds(mainWindow, { x: winX, y: winY, width: winWidth, height: winHeight }, false);
      mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('window:shown', { side: isLeft ? 'left' : 'right', expanded: false });
    }
    return;
  }

  if (mainWindow.isVisible()) {
    // Let the renderer decide: navigate back to list or hide
    mainWindow.webContents.send('window:toggle');
  } else {
    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const { x, y, width, height } = display.workArea;

    const snap = getConfigValue('snapPosition') || 'bottom-right';
    const isLeft = snap.includes('left');
    const winWidth = getConfigValue('windowWidth') || WINDOW_WIDTH;
    const winX = isLeft ? x + SNAP_MARGIN : x + width - winWidth - SNAP_MARGIN;
    const winY = y + SNAP_MARGIN;
    const winHeight = height - SNAP_MARGIN * 2;

    showTimestamp = Date.now();
    cancelBlurTimer();
    setMainBounds(mainWindow, { x: winX, y: winY, width: winWidth, height: winHeight }, false);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('window:shown', { side: isLeft ? 'left' : 'right', expanded: false });
  }
}

/** Set up snap-on-drop: debounce move events so snap only fires after drag ends. */
export function setupSnapOnDrop(): void {
  if (!mainWindow) return;

  let snapDebounce: ReturnType<typeof setTimeout> | null = null;
  mainWindow.on('move', () => {
    // Ignore moves we caused via setMainBounds — otherwise our own snap/show
    // repositioning would schedule another snap, feeding the growth loop.
    if (programmaticBounds) return;
    if (snapDebounce) clearTimeout(snapDebounce);
    snapDebounce = setTimeout(handleWindowMoved, 500);
  });
}

/** Register all window-related IPC handlers. Call after createMainWindow(). */
export function registerWindowIpcHandlers(preloadPath: string): void {
  storedPreloadPath = preloadPath;

  ipcMain.on('window:hide', () => {
    cancelBlurTimer();
    mainWindow?.hide();
  });

  ipcMain.on('window:expand', () => {
    if (!mainWindow || isExpanded) return;
    isExpanded = true;

    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const { x, y, width, height } = display.workArea;

    const newX = Math.round(x + (width - EXPANDED_WIDTH) / 2);
    const newY = Math.round(y + (height - EXPANDED_HEIGHT) / 2);

    mainWindow.setAlwaysOnTop(false);  // expanded windows are never alwaysOnTop
    mainWindow.setResizable(true);
    setMainBounds(mainWindow, { x: newX, y: newY, width: EXPANDED_WIDTH, height: EXPANDED_HEIGHT }, true);
  });

  ipcMain.on('window:collapse', () => {
    if (!mainWindow || !isExpanded) return;
    isExpanded = false;

    mainWindow.setAlwaysOnTop(shouldMainBeOnTop());

    isSnapping = true;
    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const { x, y, width, height } = display.workArea;

    const snap = getConfigValue('snapPosition') || 'bottom-right';
    const isLeft = snap.includes('left');
    const winWidth = getConfigValue('windowWidth') || WINDOW_WIDTH;
    const winX = isLeft ? x + SNAP_MARGIN : x + width - winWidth - SNAP_MARGIN;
    const winY = y + SNAP_MARGIN;
    const winHeight = height - SNAP_MARGIN * 2;

    setMainBounds(mainWindow, { x: winX, y: winY, width: winWidth, height: winHeight }, true);
    setTimeout(() => { isSnapping = false; }, 300);
  });

  // ── Pin toggle ──────────────────────────────────────────
  ipcMain.handle('window:get-pinned', () => {
    return getConfigValue('pinned');
  });

  ipcMain.on('window:set-pinned', (_event, pinned: boolean) => {
    setConfigValue('pinned', pinned);
    cancelBlurTimer();
    applyStackingPolicy();

    if (mainWindow && !isExpanded) {
      // When unpinning, snap back to full-height edge position
      if (!pinned) {
        unpinTimestamp = Date.now();
        isSnapping = true;

        const bounds = mainWindow.getBounds();
        const centerX = bounds.x + bounds.width / 2;
        const centerY = bounds.y + bounds.height / 2;
        const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY });
        const area = display.workArea;

        const isLeft = centerX < area.x + area.width / 2;
        const snap: SnapPosition = isLeft ? 'top-left' : 'top-right';
        const winWidth = getConfigValue('windowWidth') || WINDOW_WIDTH;
        const winX = isLeft ? area.x + SNAP_MARGIN : area.x + area.width - winWidth - SNAP_MARGIN;
        const winY = area.y + SNAP_MARGIN;
        const winHeight = area.height - SNAP_MARGIN * 2;

        setConfigValue('snapPosition', snap);
        setMainBounds(mainWindow, { x: winX, y: winY, width: winWidth, height: winHeight }, false);
        setTimeout(() => { isSnapping = false; }, 500);
      }
    }
    // Notify all windows so UI can update
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('window:pinned-changed', pinned);
    }
  });

  // ── Canvas popout window ────────────────────────────────
  ipcMain.on('canvas-window:open', (_event, target: { kind: string; id: string; title: string }) => {
    if (canvasWindow && !canvasWindow.isDestroyed()) {
      // Reuse the (possibly hidden, pre-warmed) primary canvas window. If
      // the renderer hasn't finished loading yet — e.g. user clicked during
      // the brief window after pre-warm started but before did-finish-load
      // — defer the load-target send until the renderer is ready.
      const reveal = () => {
        if (!canvasWindow || canvasWindow.isDestroyed()) return;
        sendCanvasTarget(canvasWindow, target);
        if (!canvasWindow.isVisible()) canvasWindow.show();
        canvasWindow.focus();
      };
      if (canvasWindow.webContents.isLoading()) {
        canvasWindow.webContents.once('did-finish-load', reveal);
      } else {
        reveal();
      }
    } else {
      canvasWindow = createCanvasWindow(preloadPath, { isPrimary: true });
      canvasWindow.webContents.once('did-finish-load', () => {
        if (canvasWindow) sendCanvasTarget(canvasWindow, target);
        canvasWindow?.show();
        canvasWindow?.focus();
      });
    }
  });

  // Renderer ack after flushing unsaved edits in response to
  // `canvas-window:request-hide`. Actually hide the window here and
  // broadcast `canvas-window:closed` so the main window's list-refresh
  // logic still fires (preserves the pre-existing UX where closing the
  // canvas updates the side pane with any title/body edits).
  //
  // On Windows, when a focused window hides, focus does NOT reliably
  // return to the previously-focused app window — it can fall through to
  // the OS, leaving the still-visible main window apparently non-typable
  // (textarea looks focused but keystrokes go nowhere). Explicitly hand
  // focus back to the main window if it's visible. macOS handles this
  // natively but the extra focus() call is a no-op there.
  ipcMain.on('canvas-window:hide-ready', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    if (win.isVisible()) win.hide();
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.focus();
    }
    mainWindow?.webContents.send('canvas-window:closed');
  });

  // Open a new canvas window (even if one already exists)
  ipcMain.on('canvas-window:open-new', (_event, target: { kind: string; id: string; title: string }) => {
    const win = createCanvasWindow(preloadPath);
    // Track as the "primary" canvas for default reuse
    canvasWindow = win;
    win.webContents.once('did-finish-load', () => {
      sendCanvasTarget(win, target);
      win.show();
    });
  });

  // Open a child page in a new canvas window
  ipcMain.on('canvas-window:open-page', (_event, target: { kind: 'page'; spaceId: string; page: string; title: string }) => {
    openPageInNewWindow(preloadPath, target.spaceId, target.page);
  });

  ipcMain.on('canvas-window:update-title', (event, title: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const target = canvasTargets.get(win.id);
    if (!target) return;
    canvasTargets.set(win.id, { ...target, title });
    emitCanvasChange();
  });

  // Toggle user-pinned state for the calling canvas window.
  // When the side pane is pinned all canvases are already alwaysOnTop;
  // per-canvas pin gives the user independent control.
  ipcMain.on('canvas-window:set-always-on-top', (event, pinned: boolean) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      if (pinned) {
        canvasUserPinned.add(win);
      } else {
        canvasUserPinned.delete(win);
      }
      win.setAlwaysOnTop(shouldCanvasBeOnTop(win));
    }
  });

  ipcMain.handle('canvas-window:get-always-on-top', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      return canvasUserPinned.has(win);
    }
    return false;
  });

  // Forward theme changes to all windows
  ipcMain.on('canvas-window:theme-changed', (_event, theme: string) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('canvas-window:theme-changed', theme);
    }
    for (const win of canvasWindows) {
      if (!win.isDestroyed()) {
        win.webContents.send('canvas-window:theme-changed', theme);
      }
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('canvas-window:theme-changed', theme);
    }
  });

  // ── Settings popout window ─────────────────────────────
  ipcMain.on('settings-window:open', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (!settingsWindow.isVisible()) settingsWindow.show();
      settingsWindow.focus();
      // The window is hidden (not destroyed) on close and pre-warmed at app
      // start, so its renderer state is as old as the last load. Ask it to
      // re-read every setting before the user sees it. Skipped while the
      // bundle is still loading — the renderer's own init load covers that.
      if (!settingsWindow.webContents.isLoading()) {
        settingsWindow.webContents.send('settings-window:refresh');
      }
    } else {
      settingsWindow = createSettingsWindow(preloadPath);
      settingsWindow.once('ready-to-show', () => {
        settingsWindow?.show();
      });
    }
  });

  // ── Cross-window agent chat ────────────────────────────
  // Canvas window requests opening an agent chat in the main panel
  ipcMain.on('main-window:open-agent-chat', (_event, data: OpenAgentChatData) => {
    openAgentChatInMainWindow(data);
  });

  // Canvas window requests opening the persona sandbox editor in the main panel.
  // Used by canvas worker-tile sandbox-block panels so the user can edit the
  // sandbox policy for the persona that launched the blocked agent without
  // leaving the demo flow. Targeted send only — no broadcast.
  ipcMain.on('main-window:open-persona-sandbox-editor', (_event, data: { personaHandle: string }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
    mainWindow.webContents.send('main-window:open-persona-sandbox-editor', data);
  });
}

// ── Internal helpers ─────────────────────────────────────

/** Open external links in the user's default browser instead of inside Electron. */
function attachExternalLinkHandler(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('whim://page/')) {
      const parts = decodeURIComponent(url.replace('whim://page/', '')).split('/');
      if (parts.length >= 2) {
        const [spaceId, ...rest] = parts;
        const page = rest.join('/');
        openPageInNewWindow(storedPreloadPath, spaceId, page);
      }
    } else if (url.startsWith('whim://space/')) {
      const spaceId = url.replace('whim://space/', '');
      navigateCanvasToSpace(win, spaceId);
    } else if (url.startsWith('file://')) {
      handleFileUrl(url);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('whim://page/')) {
      event.preventDefault();
      const parts = decodeURIComponent(url.replace('whim://page/', '')).split('/');
      if (parts.length >= 2) {
        const [spaceId, ...rest] = parts;
        const page = rest.join('/');
        openPageInNewWindow(storedPreloadPath, spaceId, page);
      }
    } else if (url.startsWith('whim://space/')) {
      event.preventDefault();
      const spaceId = url.replace('whim://space/', '');
      navigateCanvasToSpace(win, spaceId);
    } else if (url.startsWith('file://')) {
      event.preventDefault();
      handleFileUrl(url);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

/** Handle a file:// URL — open .md files under workspace in canvas, others externally. */
function handleFileUrl(url: string): void {
  try {
    const filePath = decodeURIComponent(new URL(url).pathname);
    if (isWorkspaceMdFile(filePath)) {
      openFileInNewWindow(filePath);
    } else {
      shell.openPath(filePath);
    }
  } catch {
    // Malformed URL — ignore
  }
}

/** Check if a file path is a .md file that lives inside the workspace root. */
export function isWorkspaceMdFile(filePath: string): boolean {
  const workspace = getConfigValue('workspace');
  if (!workspace) return false;
  if (!filePath.toLowerCase().endsWith('.md')) return false;

  try {
    const realWorkspace = fs.realpathSync(workspace) + nodePath.sep;
    const realFile = fs.realpathSync(filePath);
    return realFile.startsWith(realWorkspace);
  } catch {
    // File doesn't exist or can't resolve — not a workspace md file
    return false;
  }
}

/** Navigate a canvas window to a different space by sending a load-target event. */
function navigateCanvasToSpace(win: BrowserWindow, spaceId: string): void {
  if (!win.isDestroyed()) {
    sendCanvasTarget(win, { kind: 'space', id: spaceId, title: '' });
  }
}

/** Open a child page in a new canvas window. */
function openPageInNewWindow(preloadPath: string, spaceId: string, page: string): void {
  const win = createCanvasWindow(preloadPath);
  const target = { kind: 'page' as const, spaceId, page, title: page };
  win.webContents.once('did-finish-load', () => {
    sendCanvasTarget(win, target);
    win.show();
  });
}

/** Open a workspace .md file in a new canvas window. */
export function openFileInNewWindow(filePath: string): void {
  const title = filePath.split('/').pop()?.replace(/\.md$/i, '') ?? filePath;
  const win = createCanvasWindow(storedPreloadPath);
  const target = { kind: 'file' as const, filePath, title };
  win.webContents.once('did-finish-load', () => {
    sendCanvasTarget(win, target);
    win.show();
  });
}

/** Persist the user's preferred width when they resize the window. */
function attachResizePersist(win: BrowserWindow): void {
  let resizeDebounce: ReturnType<typeof setTimeout> | null = null;
  win.on('resize', () => {
    if (isExpanded || isSnapping || programmaticBounds) return;
    if (resizeDebounce) clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      if (!win.isDestroyed()) {
        const { width } = win.getBounds();
        setConfigValue('windowWidth', width);
      }
    }, 300);
  });
}

/** Attach blur handler that lets the renderer animate out before hiding. */
function attachBlurHide(win: BrowserWindow): void {
  win.on('blur', () => {
    // Only auto-hide when the policy says so
    if (!shouldBlurHide()) return;

    // Ignore blur if window was just shown (e.g. from tray menu click)
    if (Date.now() - showTimestamp < 300) return;

    // Ignore blur caused by setBounds repositioning after unpin
    if (Date.now() - unpinTimestamp < 500) return;

    // Let renderer decide whether to stay and animate out if hiding
    win.webContents.send('window:request-hide');

    // Safety: hide even if renderer doesn't respond in time
    cancelBlurTimer();
    blurHideTimer = setTimeout(() => {
      // Re-check policy in case it changed during the delay
      if (!shouldBlurHide()) { blurHideTimer = null; return; }
      if (!win.isDestroyed() && win.isVisible()) win.hide();
      blurHideTimer = null;
    }, 400);
  });
}

/** Derive pixel coordinates from a snap position on the nearest display. */
function getSnapCoords(snap: SnapPosition, winWidth = WINDOW_WIDTH, winHeight = WINDOW_HEIGHT): { x: number; y: number } {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.workArea;

  let sx: number;
  let sy: number;

  switch (snap) {
    case 'top-left':
      sx = x + SNAP_MARGIN;
      sy = y + SNAP_MARGIN;
      break;
    case 'top-right':
      sx = x + width - winWidth - SNAP_MARGIN;
      sy = y + SNAP_MARGIN;
      break;
    case 'bottom-left':
      sx = x + SNAP_MARGIN;
      sy = y + height - winHeight - SNAP_MARGIN;
      break;
    case 'left-center':
      sx = x + SNAP_MARGIN;
      sy = Math.round(y + (height - winHeight) / 2);
      break;
    case 'right-center':
      sx = x + width - winWidth - SNAP_MARGIN;
      sy = Math.round(y + (height - winHeight) / 2);
      break;
    case 'bottom-right':
    default:
      sx = x + width - winWidth - SNAP_MARGIN;
      sy = y + height - winHeight - SNAP_MARGIN;
      break;
  }

  return { x: sx, y: sy };
}

/** Determine the nearest snap slot from arbitrary pixel coordinates. */
function detectSnapSlot(winX: number, winY: number, winWidth: number, winHeight: number): SnapPosition | null {
  const centerX = winX + winWidth / 2;
  const centerY = winY + winHeight / 2;
  const display = screen.getDisplayNearestPoint({ x: centerX, y: centerY });
  const area = display.workArea;

  const edgeThreshold = 80;
  const nearLeft = winX - area.x < edgeThreshold;
  const nearRight = (area.x + area.width) - (winX + winWidth) < edgeThreshold;
  const nearTop = winY - area.y < edgeThreshold;
  const nearBottom = (area.y + area.height) - (winY + winHeight) < edgeThreshold;

  // Must be near at least one edge
  if (!nearLeft && !nearRight && !nearTop && !nearBottom) return null;

  const midY = area.y + area.height / 2;
  const isCenterVertical = Math.abs(centerY - midY) < area.height * 0.2;

  if (nearLeft && isCenterVertical) return 'left-center';
  if (nearRight && isCenterVertical) return 'right-center';
  if (nearLeft && nearTop) return 'top-left';
  if (nearRight && nearTop) return 'top-right';
  if (nearLeft && nearBottom) return 'bottom-left';
  if (nearRight && nearBottom) return 'bottom-right';
  if (nearTop) return centerX < area.x + area.width / 2 ? 'top-left' : 'top-right';
  if (nearBottom) return centerX < area.x + area.width / 2 ? 'bottom-left' : 'bottom-right';
  if (nearLeft) return 'left-center';
  if (nearRight) return 'right-center';

  return null;
}

/** Snap the window to the nearest edge after a user drag. Only operates in collapsed mode. */
function handleWindowMoved(): void {
  if (!mainWindow || mainWindow.isDestroyed() || isExpanded || isSnapping || programmaticBounds) return;
  // Don't snap when pinned — allow free positioning
  if (getConfigValue('pinned')) return;

  try {
    const bounds = mainWindow.getBounds();
    const slot = detectSnapSlot(bounds.x, bounds.y, bounds.width, bounds.height);
    if (!slot) return;

    isSnapping = true;
    const coords = getSnapCoords(slot, bounds.width, bounds.height);
    const x = Math.round(coords.x);
    const y = Math.round(coords.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn('[window-manager] Invalid snap coordinates, skipping:', { x, y });
      isSnapping = false;
      return;
    }
    setMainBounds(mainWindow, { x, y, width: bounds.width, height: bounds.height }, false);
    setConfigValue('snapPosition', slot);

    // Clear guard after animation
    setTimeout(() => { isSnapping = false; }, 300);
  } catch (err) {
    isSnapping = false;
    console.warn('[window-manager] handleWindowMoved error:', err);
  }
}

function createCanvasWindow(preloadPath: string, options: { isPrimary?: boolean } = {}): BrowserWindow {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.workArea;

  const iconPath = getWindowIconPath();
  const win = new BrowserWindow({
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    x: Math.round(x + (width - CANVAS_WIDTH) / 2),
    y: Math.round(y + (height - CANVAS_HEIGHT) / 2),
    show: false,
    alwaysOnTop: getConfigValue('pinned'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 20 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL('copilot-whim://app/renderer/index.html?mode=canvas');
  attachExternalLinkHandler(win);

  canvasWindows.add(win);

  // Keep the tray menu in sync as this canvas is shown/hidden.
  win.on('show', emitCanvasChange);
  win.on('hide', emitCanvasChange);

  // Primary canvas window: hide-on-close so the renderer stays warm for the
  // next open. The renderer flushes any unsaved edits before acking via the
  // `canvas-window:hide-ready` handler, which then calls win.hide() and
  // broadcasts `canvas-window:closed` to the main window so its list-refresh
  // logic still fires. The flag is bypassed during app quit (see
  // `releaseCanvasWindow`) and during workspace switch (see
  // `destroyCanvasWindow`).
  if (options.isPrimary) {
    win.on('close', (event) => {
      if (canvasWindowAllowClose) return;
      if (win.isDestroyed()) return;
      if (canvasWindow !== win) return;
      event.preventDefault();
      win.webContents.send('canvas-window:request-hide');
    });
  }

  win.on('closed', () => {
    canvasWindows.delete(win);
    canvasTargets.delete(win.id);
    if (canvasWindow === win) canvasWindow = null;
    mainWindow?.webContents.send('canvas-window:closed');
    emitCanvasChange();
  });

  return win;
}

function createSettingsWindow(preloadPath: string): BrowserWindow {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.workArea;

  const isMac = process.platform === 'darwin';
  const iconPath = getWindowIconPath();

  const win = new BrowserWindow({
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    x: Math.round(x + (width - SETTINGS_WIDTH) / 2),
    y: Math.round(y + (height - SETTINGS_HEIGHT) / 2),
    show: false,
    alwaysOnTop: true,
    title: 'Settings',
    // macOS: hidden inset title bar; Windows/Linux: frameless
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 20 } }
      : { frame: false }),
    autoHideMenuBar: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadURL('copilot-whim://app/renderer/index.html?mode=settings');
  attachExternalLinkHandler(win);

  // Hide instead of destroy so subsequent opens are instant. The renderer
  // process stays alive in the background; only an explicit `destroy()`
  // (during app quit, see `releaseSettingsWindow`) actually closes it.
  win.on('close', (event) => {
    if (settingsWindowAllowClose) return;
    if (win.isDestroyed()) return;
    event.preventDefault();
    win.hide();
  });

  win.on('closed', () => {
    settingsWindow = null;
  });

  return win;
}

/**
 * Broadcast a hotkey config change to every live window. Renderers cache the
 * resolved hotkey map for their own key handling, so an edit made in the
 * settings popout would otherwise leave every other window on stale bindings
 * until the app restarts.
 */
export function broadcastHotkeysChanged(): void {
  const targets = [mainWindow, settingsWindow, ...canvasWindows];
  for (const win of targets) {
    if (win && !win.isDestroyed()) {
      win.webContents.send('hotkeys:changed');
    }
  }
}

/**
 * Pre-warm the settings window at app start so the first open is instant.
 * Creates the window hidden; the renderer process and bundle load happen
 * in the background. No-op if a settings window already exists.
 */
export function preWarmSettingsWindow(preloadPath: string): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) return;
  settingsWindow = createSettingsWindow(preloadPath);
}

/**
 * Allow the settings window to actually close (used during app quit so the
 * hide-on-close interceptor doesn't prevent shutdown). After this is
 * called, subsequent close events on the settings window will close it
 * normally. Safe to call multiple times.
 */
export function releaseSettingsWindow(): void {
  settingsWindowAllowClose = true;
}

/**
 * Destroy the (possibly hidden) settings window. Use this when the
 * underlying data the settings window depends on has changed in a way
 * that the cached renderer state can't recover from (e.g. workspace
 * switch) — the next `settings-window:open` will cold-start a fresh
 * renderer with up-to-date data.
 */
export function destroySettingsWindow(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = null;
    return;
  }
  const win = settingsWindow;
  settingsWindowAllowClose = true;
  try {
    win.destroy();
  } finally {
    // Reset the flag — future settings windows should hide on close,
    // not destroy, until `releaseSettingsWindow()` is called again.
    settingsWindowAllowClose = false;
    settingsWindow = null;
  }
}

/**
 * Pre-warm the primary canvas window at app start so the first open is
 * instant. Creates the window hidden; the renderer process and bundle
 * load happen in the background. No-op if a primary canvas window
 * already exists. Mirrors `preWarmSettingsWindow`.
 */
export function preWarmCanvasWindow(preloadPath: string): void {
  if (canvasWindow && !canvasWindow.isDestroyed()) return;
  canvasWindow = createCanvasWindow(preloadPath, { isPrimary: true });
}

/**
 * Allow the primary canvas window to actually close (used during app quit
 * so the hide-on-close interceptor doesn't prevent shutdown). After this
 * is called, subsequent close events on the canvas window will close it
 * normally. Safe to call multiple times.
 */
export function releaseCanvasWindow(): void {
  canvasWindowAllowClose = true;
}

/**
 * Destroy the (possibly hidden) primary canvas window. Use this when the
 * underlying data the canvas depends on has changed in a way that the
 * cached renderer state can't recover from (e.g. workspace switch) — the
 * next `canvas-window:open` will cold-start a fresh renderer (or hit the
 * next pre-warm if scheduled).
 */
export function destroyCanvasWindow(): void {
  if (!canvasWindow || canvasWindow.isDestroyed()) {
    canvasWindow = null;
    return;
  }
  const win = canvasWindow;
  canvasWindowAllowClose = true;
  try {
    win.destroy();
  } finally {
    // Reset the flag — future primary canvas windows should hide on
    // close, not destroy, until `releaseCanvasWindow()` is called again.
    canvasWindowAllowClose = false;
    canvasWindow = null;
  }
}
