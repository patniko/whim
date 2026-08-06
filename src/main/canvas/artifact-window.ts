/**
 * Canvas artifact windows.
 *
 * A separate, deliberately minimal window type: it renders untrusted
 * agent-authored HTML from the isolated `whim-artifact://` origin, so it gets
 * no preload, no IPC bridge, no Node integration and no navigation.
 *
 * Kept apart from the markdown canvas windows in window-manager.ts — those are
 * a different concept (a Milkdown editor over canvas.md) that intentionally has
 * a privileged preload.
 */
import { BrowserWindow, shell } from 'electron';
import { EventEmitter } from 'events';
import { ARTIFACT_PARTITION, ARTIFACT_SCHEME, buildArtifactUrl } from './artifact-protocol';

const ARTIFACT_WIDTH = 900;
const ARTIFACT_HEIGHT = 760;

export interface ArtifactWindowKey {
  spaceId: string;
  artifactId: string;
}

export interface OpenArtifactWindow extends ArtifactWindowKey {
  winId: number;
  title: string;
  /** SDK canvas instance this window is showing, when opened by the agent. */
  instanceId?: string;
}

interface TrackedArtifactWindow extends OpenArtifactWindow {
  win: BrowserWindow;
}

const windows = new Map<number, TrackedArtifactWindow>();
const changeEmitter = new EventEmitter();
changeEmitter.setMaxListeners(50);

/** Notified when the user closes an artifact window, so the SDK session can be told. */
type CloseListener = (window: OpenArtifactWindow) => void;
let closeListener: CloseListener | null = null;

export function onArtifactWindowClosed(listener: CloseListener | null): void {
  closeListener = listener;
}

export function onArtifactWindowsChanged(cb: () => void): () => void {
  changeEmitter.on('change', cb);
  return () => { changeEmitter.off('change', cb); };
}

function emitChange(): void {
  changeEmitter.emit('change');
}

function keyOf(key: ArtifactWindowKey): string {
  return `${key.spaceId}::${key.artifactId}`;
}

function find(key: ArtifactWindowKey): TrackedArtifactWindow | null {
  const wanted = keyOf(key);
  for (const tracked of windows.values()) {
    if (keyOf(tracked) === wanted && !tracked.win.isDestroyed()) return tracked;
  }
  return null;
}

export interface OpenArtifactWindowOptions extends ArtifactWindowKey {
  title?: string;
  instanceId?: string;
  /**
   * Whether to show and focus the window. Scheduled runs pass false so an
   * unattended refresh never steals focus; the notification and the space chip
   * are the only signals.
   */
  focus?: boolean;
}

/**
 * Open (or focus) the window for an artifact. Repeated calls for the same
 * artifact reuse the existing window rather than stacking duplicates.
 */
export function openArtifactWindow(options: OpenArtifactWindowOptions): OpenArtifactWindow {
  const { spaceId, artifactId, instanceId } = options;
  const title = options.title?.trim() || 'Canvas';
  const focus = options.focus !== false;

  const existing = find({ spaceId, artifactId });
  if (existing) {
    existing.title = title;
    if (instanceId) existing.instanceId = instanceId;
    existing.win.setTitle(title);
    if (focus) {
      if (!existing.win.isVisible()) existing.win.show();
      existing.win.focus();
    }
    emitChange();
    return toPublic(existing);
  }

  const win = new BrowserWindow({
    width: ARTIFACT_WIDTH,
    height: ARTIFACT_HEIGHT,
    show: false,
    title,
    webPreferences: {
      // No preload and no Node: the page is untrusted agent output.
      partition: ARTIFACT_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  hardenArtifactWebContents(win);
  win.loadURL(buildArtifactUrl(spaceId, artifactId));

  const tracked: TrackedArtifactWindow = {
    winId: win.id,
    spaceId,
    artifactId,
    title,
    ...(instanceId ? { instanceId } : {}),
    win,
  };
  windows.set(win.id, tracked);

  win.on('show', emitChange);
  win.on('hide', emitChange);
  win.on('closed', () => {
    const entry = windows.get(win.id);
    windows.delete(win.id);
    if (entry) closeListener?.(toPublic(entry));
    emitChange();
  });

  if (focus) {
    win.show();
    win.focus();
  }

  emitChange();
  return toPublic(tracked);
}

function toPublic(tracked: TrackedArtifactWindow): OpenArtifactWindow {
  const { win: _win, ...rest } = tracked;
  return { ...rest };
}

/**
 * Lock the window down: artifacts may not navigate, open windows, request
 * permissions, or download. Ordinary web links go to the system browser so a
 * canvas can still be a jumping-off point for follow-up.
 */
function hardenArtifactWebContents(win: BrowserWindow): void {
  const { webContents } = win;

  webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    // The initial load is not a navigation; anything after it is.
    if (url.startsWith(`${ARTIFACT_SCHEME}://`)) return;
    event.preventDefault();
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
  });

  webContents.on('will-redirect', event => {
    event.preventDefault();
  });

  webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });
  webContents.session.setPermissionCheckHandler(() => false);
  webContents.session.on('will-download', event => {
    event.preventDefault();
  });
}

/** Reload any open window showing this artifact, e.g. after a republish. */
export function reloadArtifactWindow(key: ArtifactWindowKey): boolean {
  const tracked = find(key);
  if (!tracked) return false;
  tracked.win.webContents.reload();
  return true;
}

/** Update the OS window title, e.g. after a status change. */
export function setArtifactWindowTitle(key: ArtifactWindowKey, title: string): void {
  const tracked = find(key);
  if (!tracked) return;
  tracked.title = title;
  tracked.win.setTitle(title);
  emitChange();
}

/** Visible artifact windows, for the tray. */
export function getOpenArtifactWindows(): OpenArtifactWindow[] {
  const result: OpenArtifactWindow[] = [];
  for (const tracked of windows.values()) {
    if (tracked.win.isDestroyed() || !tracked.win.isVisible()) continue;
    result.push(toPublic(tracked));
  }
  return result;
}

export function focusArtifactWindow(winId: number): void {
  const tracked = windows.get(winId);
  if (!tracked || tracked.win.isDestroyed()) return;
  if (!tracked.win.isVisible()) tracked.win.show();
  tracked.win.focus();
}

/** Find the window currently showing an SDK canvas instance. */
export function findArtifactWindowByInstance(instanceId: string): OpenArtifactWindow | null {
  for (const tracked of windows.values()) {
    if (tracked.instanceId === instanceId && !tracked.win.isDestroyed()) return toPublic(tracked);
  }
  return null;
}

/**
 * Close an artifact window. `notify` is false when the close was initiated by
 * the agent or the session itself, so we do not echo a close back into it.
 */
export function closeArtifactWindow(key: ArtifactWindowKey, notify = true): boolean {
  const tracked = find(key);
  if (!tracked) return false;
  if (!notify) windows.delete(tracked.winId);
  tracked.win.close();
  if (!notify) emitChange();
  return true;
}

/** Close every artifact window, e.g. on workspace switch or quit. */
export function closeAllArtifactWindows(): void {
  for (const tracked of [...windows.values()]) {
    windows.delete(tracked.winId);
    if (!tracked.win.isDestroyed()) tracked.win.close();
  }
  emitChange();
}

/** Test seam. */
export function resetArtifactWindowsForTests(): void {
  windows.clear();
  closeListener = null;
  changeEmitter.removeAllListeners();
}
