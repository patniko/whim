import { BrowserWindow, dialog, screen } from 'electron';

/** Approximate size of the macOS open panel, used to center the anchor. */
const SHEET_WIDTH = 760;
const SHEET_HEIGHT = 500;

/**
 * Build a throwaway, invisible parent window positioned so a macOS sheet
 * attached to it lands centered over `win`, clamped to that display's work
 * area.
 *
 * Why this exists: on macOS a dialog with a parent renders as a document-modal
 * sheet centered on the parent's top edge. whim's main window is a narrow
 * full-height strip snapped to a screen edge, so a sheet anchored to it spills
 * off-screen. Anchoring to a correctly-placed invisible window instead gives
 * the sheet a sane position without moving the real window.
 */
function createSheetAnchor(win: BrowserWindow): BrowserWindow | null {
  try {
    const winBounds = win.getBounds();
    const area = screen.getDisplayMatching(winBounds).workArea;

    const centerX = winBounds.x + winBounds.width / 2;
    const centerY = winBounds.y + winBounds.height / 2;

    const width = Math.min(SHEET_WIDTH, area.width);
    const height = Math.min(SHEET_HEIGHT, area.height);

    const clamp = (value: number, min: number, max: number): number =>
      Math.round(Math.max(min, Math.min(value, max)));

    const x = clamp(centerX - width / 2, area.x, area.x + area.width - width);
    // The sheet drops from the anchor's top edge, so place that edge where the
    // top of the sheet should sit.
    const y = clamp(centerY - height / 2, area.y, area.y + area.height - height);

    const anchor = new BrowserWindow({
      x,
      y,
      width,
      height,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      skipTaskbar: true,
      // Deliberately focusable: AppKit expects a sheet's parent to be able to
      // become the key window, otherwise the panel can't take keyboard input.
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      acceptFirstMouse: false,
      alwaysOnTop: win.isAlwaysOnTop(),
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    anchor.setIgnoreMouseEvents(true);
    anchor.showInactive();
    return anchor;
  } catch {
    return null;
  }
}

/**
 * Show a native open dialog positioned over `win`.
 *
 * macOS gets an invisible anchor window (see {@link createSheetAnchor}) so the
 * sheet appears centered on the whim window instead of hanging off the edge of
 * the screen. Other platforms center the dialog over the parent natively, so
 * they just use the real window.
 */
export async function showOpenDialog(
  win: BrowserWindow | null,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  if (!win) return dialog.showOpenDialog(options);
  if (process.platform !== 'darwin') return dialog.showOpenDialog(win, options);

  const anchor = createSheetAnchor(win);
  if (!anchor) return dialog.showOpenDialog(options);
  try {
    return await dialog.showOpenDialog(anchor, options);
  } finally {
    try {
      anchor.destroy();
    } catch {
      // best-effort teardown
    }
  }
}
