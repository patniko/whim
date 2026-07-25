import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';

/**
 * Show a native open dialog.
 *
 * On macOS, passing a parent window turns the dialog into a document-modal
 * sheet anchored to that window. Our main window is a narrow full-height strip
 * snapped to a screen edge, so the sheet — which is much wider than the strip —
 * spills off the screen. Showing it app-modal instead lets macOS center it on
 * the display. Other platforms center the dialog over the parent, which is
 * fine, so they keep the parent association.
 */
export function showOpenDialog(
  win: BrowserWindow | null,
  options: Electron.OpenDialogOptions
): Promise<Electron.OpenDialogReturnValue> {
  if (win && process.platform !== 'darwin') {
    return dialog.showOpenDialog(win, options);
  }
  return dialog.showOpenDialog(options);
}
