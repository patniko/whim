import { registerIpcHandler } from './ipc/registry';
import { app, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import type { UpdateState } from '../shared/types';
import { sendToAllWindows } from './ipc/typed-handler';
import { getConfigValue } from './config';
import {
  startChecking,
  updateAvailable,
  updateNotAvailable,
  downloadProgress,
  updateDownloaded,
  updateError,
} from './update-state';

const CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

let currentState: UpdateState = { status: 'disabled' };
let checkTimer: ReturnType<typeof setInterval> | null = null;
let autoUpdater: any = null;
let logFilePath: string | null = null;

// Tracks whether the in-flight check was started by the user (Settings → "Check
// for updates now") or by the background timer. We only surface a visible
// "You're up to date" confirmation for manual checks; background checks stay quiet.
let pendingCheckInitiatedBy: 'auto' | 'manual' = 'auto';

function safeGetVersion(): string | undefined {
  try {
    return app.getVersion();
  } catch {
    return undefined;
  }
}

/**
 * Merge a partial update into the current state and broadcast it. `currentVersion`
 * is sticky once known so every state the renderer receives can show it.
 */
function setState(next: Partial<UpdateState>) {
  currentState = { ...currentState, ...next };
  sendToAllWindows('update:state-changed', currentState);
}

export function getUpdateState(): UpdateState {
  return currentState;
}

export function setAutoDownload(enabled: boolean) {
  if (autoUpdater) {
    autoUpdater.autoDownload = enabled;
  }
}

function configureLogger(): any {
  try {
    const mod = require('electron-log/main');
    const log = mod?.default ?? mod;
    logFilePath = path.join(app.getPath('userData'), 'logs', 'update.log');
    log.transports.file.level = 'info';
    log.transports.file.resolvePathFn = () => logFilePath as string;
    // Keep the console transport quiet in production; the file is the source of truth.
    if (log.transports.console) log.transports.console.level = app.isPackaged ? false : 'info';
    return log;
  } catch (err: any) {
    console.error('[update] Failed to configure electron-log:', err?.message);
    return console;
  }
}

function runCheck(initiatedBy: 'auto' | 'manual', log: any) {
  if (!autoUpdater) {
    // Not packaged / updater unavailable — reflect that for manual checks so the
    // Settings panel can explain why nothing happens in a dev build.
    if (initiatedBy === 'manual') {
      setState({ status: 'disabled', checkInitiatedBy: 'manual', lastCheckedAt: Date.now() });
    }
    return;
  }
  pendingCheckInitiatedBy = initiatedBy;
  log.info(`[update] checkForUpdates (${initiatedBy})`);
  autoUpdater.checkForUpdates().catch((err: any) => {
    log.error('[update] checkForUpdates rejected:', err?.message ?? err);
    // The 'error' event usually fires too, but guarantee the failure is visible.
    setState(updateError(currentState, err?.message ?? String(err)));
  });
}

/**
 * IPC handlers are registered unconditionally (even in dev / unpackaged builds)
 * so the Settings "Updates" panel can always read the current version, open the
 * log, and — when packaged — trigger checks. Check/download/install are no-ops
 * when the updater isn't active.
 */
function registerUpdateIpc(log: any) {
  registerIpcHandler('update:get-state', () => currentState);

  registerIpcHandler('update:open-log', async () => {
    try {
      const dir = logFilePath ? path.dirname(logFilePath) : app.getPath('userData');
      fs.mkdirSync(dir, { recursive: true });
      const target = logFilePath && fs.existsSync(logFilePath) ? logFilePath : dir;
      const openErr = await shell.openPath(target);
      if (openErr) return { error: openErr };
      return { ok: true as const };
    } catch (err: any) {
      return { error: err?.message ?? 'Failed to open update log' };
    }
  });

  registerIpcHandler('update:install', () => {
    if (!autoUpdater) return;
    log.info('[update] Install requested — quitAndInstall()');
    autoUpdater.quitAndInstall();
  });

  registerIpcHandler('update:check', () => {
    runCheck('manual', log);
  });

  registerIpcHandler('update:download', () => {
    if (!autoUpdater) return;
    log.info('[update] Manual download requested');
    autoUpdater.downloadUpdate().catch((err: any) => {
      log.error('[update] Download failed:', err?.message ?? err);
      setState(updateError(currentState, err?.message ?? String(err)));
    });
  });
}

export function initAutoUpdater() {
  // Always expose our own version + log path so the Settings panel works in dev.
  currentState = { ...currentState, currentVersion: safeGetVersion() };
  const log = configureLogger();
  registerUpdateIpc(log);

  if (!app.isPackaged) {
    log.info('[update] Skipping auto-updater — app is not packaged (dev build)');
    setState({ status: 'disabled' });
    return;
  }

  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch (err: any) {
    log.error('[update] Failed to load electron-updater:', err?.message);
    setState({ status: 'error', error: `Updater unavailable: ${err?.message ?? err}` });
    return;
  }

  autoUpdater.logger = log;
  autoUpdater.autoDownload = getConfigValue('autoDownloadUpdates');
  autoUpdater.autoInstallOnAppQuit = true;

  setState({ status: 'idle' });

  autoUpdater.on('checking-for-update', () => {
    setState(startChecking(currentState, pendingCheckInitiatedBy));
  });

  autoUpdater.on('update-available', (info: any) => {
    setState(updateAvailable(currentState, info?.version, autoUpdater.autoDownload));
  });

  autoUpdater.on('update-not-available', () => {
    setState(updateNotAvailable(currentState, pendingCheckInitiatedBy));
  });

  autoUpdater.on('download-progress', (progress: any) => {
    setState(downloadProgress(currentState, progress?.percent));
  });

  autoUpdater.on('update-downloaded', (info: any) => {
    setState(updateDownloaded(currentState, info?.version));
  });

  autoUpdater.on('error', (err: any) => {
    log.error('[update] Error:', err?.stack ?? err?.message ?? err);
    setState(updateError(currentState, err?.message ?? String(err)));
  });

  // Initial check on launch.
  runCheck('auto', log);

  // Periodic background checks.
  checkTimer = setInterval(() => runCheck('auto', log), CHECK_INTERVAL_MS);
}

export function cleanupAutoUpdater() {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
