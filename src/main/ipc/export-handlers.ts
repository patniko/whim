import { registerIpcHandler } from './registry';
import { shell, BrowserWindow, ShareMenu } from 'electron';
import * as fs from 'fs';
import { buildExport } from '../export';
import {
  getExportDestinations,
  setExportDestinations,
  getExportDestinationById,
  type ExportFormat,
} from '../config';
import { showOpenDialog } from './dialog-utils';

export function registerExportHandlers(): void {
  // Export a canvas to a temp file and return its path (no sharing/reveal).
  registerIpcHandler('canvas:export', async (_event, spaceId: string, format: ExportFormat) => {
    return buildExport(spaceId, format);
  });

  // Export a canvas, then hand it to the OS share sheet (macOS) or reveal it in
  // the file manager (Windows/Linux fallback — no native share API in Electron).
  registerIpcHandler('canvas:share', async (event, spaceId: string, format: ExportFormat) => {
    const result = await buildExport(spaceId, format);
    if ('error' in result) return result;

    if (process.platform === 'darwin') {
      try {
        const menu = new ShareMenu({ filePaths: [result.path] });
        const win = BrowserWindow.fromWebContents(event.sender);
        menu.popup(win ? { window: win } : undefined);
        return { ok: true as const, method: 'os-share' as const };
      } catch {
        // Fall back to revealing the file on any share failure.
        shell.showItemInFolder(result.path);
        return { ok: true as const, method: 'reveal' as const };
      }
    }

    shell.showItemInFolder(result.path);
    return { ok: true as const, method: 'reveal' as const };
  });

  // Export a canvas straight into a configured destination folder, then reveal
  // it so the user can confirm / open it in the synced app.
  registerIpcHandler(
    'canvas:export-to-destination',
    async (_event, spaceId: string, destinationId: string, format?: ExportFormat) => {
      const dest = getExportDestinationById(destinationId);
      if (!dest) return { error: 'destination_not_found' };
      if (!fs.existsSync(dest.path)) return { error: 'destination_missing' };

      const result = await buildExport(spaceId, format || dest.defaultFormat, dest.path);
      if ('error' in result) return result;

      shell.showItemInFolder(result.path);
      return result;
    },
  );

  registerIpcHandler('export-destinations:list', () => {
    return getExportDestinations();
  });

  registerIpcHandler('export-destinations:save', (_event, destinations: unknown) => {
    try {
      const saved = setExportDestinations(destinations);
      return { ok: true as const, destinations: saved };
    } catch (err: any) {
      return { error: err?.message || 'save_failed' };
    }
  });

  // Generic directory picker used by the export-destinations settings editor.
  registerIpcHandler('dialog:select-folder', async (event, options?: { title?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOpts = {
      title: options?.title || 'Select Folder',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = await showOpenDialog(win, dialogOpts);

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true as const };
    }
    return { path: result.filePaths[0] };
  });
}
