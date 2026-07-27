import { Tray, Menu, nativeImage, app } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import * as path from 'path';
import {
  toggleWindow,
  getOpenCanvases,
  focusCanvasWindow,
  onCanvasWindowsChanged,
  openAgentChatInMainWindow,
} from './window-manager';
import { listTrayWorkers, onAgentListChanged, type TrayWorker } from './agent-service';
import { getConfigValue } from './config';

let tray: Tray | null = null;
const unsubscribers: Array<() => void> = [];
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

/** Max characters shown for a worker/canvas label in the menu. */
const LABEL_MAX = 50;

function truncate(text: string, max = LABEL_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function statusIcon(status: TrayWorker['status']): string {
  if (status === 'waiting-approval') return '⏸';
  return '▶';
}

function workerLabel(worker: TrayWorker): string {
  const text = worker.summary?.trim() || worker.selectedText?.trim() || 'Worker';
  return `${statusIcon(worker.status)}  ${truncate(text)}`;
}

function getIconPath(): string {
  const iconName = process.platform === 'win32' ? 'tray-icon-16.png' : 'tray-icon.png';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', iconName);
  }
  // Dev mode: assets are in src/assets relative to project root
  return path.join(__dirname, '..', '..', 'src', 'assets', iconName);
}

function buildContextMenu(): Menu {
  const remoteEnabled = !!getConfigValue('remoteEnabled');
  const template: MenuItemConstructorOptions[] = [];

  // Insert a separator only between sections — never as the leading entry.
  const pushSeparator = () => {
    const last = template[template.length - 1];
    if (last && last.type !== 'separator') template.push({ type: 'separator' });
  };

  // ── Active workers ───────────────────────────────────
  const workers = listTrayWorkers();
  if (workers.length > 0) {
    pushSeparator();
    template.push({ label: 'Workers', enabled: false });
    for (const worker of workers) {
      template.push({
        label: workerLabel(worker),
        click: () =>
          openAgentChatInMainWindow({
            agentId: worker.agentId,
            agentPrompt: worker.selectedText,
            agentStatus: worker.status,
            agentSource: worker.source,
            spaceId: worker.spaceId,
          }),
      });
    }
  }

  // ── Open canvases ────────────────────────────────────
  const canvases = getOpenCanvases();
  if (canvases.length > 0) {
    pushSeparator();
    template.push({ label: 'Canvases', enabled: false });
    for (const canvas of canvases) {
      template.push({
        label: truncate(canvas.label),
        click: () => focusCanvasWindow(canvas.winId),
      });
    }
  }

  pushSeparator();
  template.push(
    {
      label: remoteEnabled ? '📱 Remote Control ✓' : '📱 Remote Control',
      click: async () => {
        const { setAppRemote } = await import('./agent-service');
        await setAppRemote(!remoteEnabled);
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  );

  return Menu.buildFromTemplate(template);
}

/** Rebuild the tray context menu (e.g. after remote/worker/canvas state changes). */
export function rebuildTrayMenu(): void {
  if (tray) {
    tray.setContextMenu(buildContextMenu());
  }
}

/** Debounced rebuild — coalesces bursts of worker/canvas change events. */
function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuildTrayMenu();
  }, 250);
}

/** Create and show the system tray icon. Call once after app is ready. */
export function createTray(): void {
  const icon = nativeImage.createFromPath(getIconPath());
  // On macOS, mark as template so it adapts to dark/light menu bar
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  tray.setToolTip('whim');
  tray.setContextMenu(buildContextMenu());
  tray.on('click', () => toggleWindow('tray'));

  // Keep the menu fresh as workers and canvases come and go.
  unsubscribers.push(onAgentListChanged(scheduleRebuild));
  unsubscribers.push(onCanvasWindowsChanged(scheduleRebuild));
}

/** Destroy the tray icon (called on app quit). */
export function destroyTray(): void {
  if (rebuildTimer) {
    clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
  for (const unsub of unsubscribers.splice(0)) {
    try { unsub(); } catch { /* non-fatal */ }
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
