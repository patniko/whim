// Pin userData to a stable, productName-independent location. MUST be first so
// the path is set before any module resolves app.getPath('userData') at load.
import './app-paths';
import { app, BrowserWindow, dialog, globalShortcut, session, protocol, net, powerMonitor, systemPreferences } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, getConfigValue, setConfigValue, getResolvedHotkeys } from './config';
import { initDatabase, closeDatabase, mergeSessionIds, syncCanvasContent, initWorkspace, withWorkspaceContext, getStorageReadiness } from './storage';
import { startStorageMaintenance, stopStorageMaintenance } from './storage-maintenance';
import { getDbPath, getLogRoot, drainGitOperations, commitNow } from './workspace';
import { startSkillWatcher, stopSkillWatcher } from './skill-watcher';
import { startScheduler, stopScheduler } from './services/scheduler';
import { migrateOldDatabase } from './storage';
import { registerIpcHandlers } from './ipc';
import { initCopilot, shutdownCopilot } from './ai';
import { startCliExitMonitor, stopCliExitMonitor, reconcileStaleAgents, stopWorkspaceAgents } from './agent-service';
import { createMainWindow, toggleWindow, setupSnapOnDrop, registerWindowIpcHandlers, whenRendererReady, releaseSettingsWindow, releaseCanvasWindow } from './window-manager';
import { serveAppRequest } from './app-protocol';
import { createTray, destroyTray } from './tray';
import { initAutoUpdater, cleanupAutoUpdater, registerUpdateHandlers } from './update-service';
import { syncWebRemoteServer, stopWebRemoteServer, refreshWebRemoteBindings } from './web/server';
import { restoreActiveCloudPollers, stopAllCloudPollers } from './cloud-agent-poller';
import { registerArtifactSchemePrivileges, registerArtifactProtocol } from './canvas/artifact-protocol';
import { resolveSpaceLocation } from './canvas/space-location';
import { installLifecycleHandler, prepareShutdown } from './lifecycle';
import { stopSyncPolling, restartWorkspaceServices } from './ipc/workspace-handlers';
import { stopAllWatchers } from './canvas-watcher';
import { registerIpcHandler } from './ipc/registry';
import { notifyAllWindows } from './notify';
import { drainProducers, pauseWorkspaceCommands } from './producer-tasks';
import { getPerformanceTimings } from '../shared/performance';
import { shutdownVoice } from './voice';

let currentToggleAccelerator: string | null = null;
let toggleShortcutRegistered = false;

/** Whether the OS currently has the global toggle shortcut bound to whim. */
export function isToggleShortcutRegistered(): boolean {
  return toggleShortcutRegistered;
}

// Windows toast notifications require an AppUserModelId to be properly
// associated with the app in the notification center.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.patniko.whim');
}

// Suppress EPIPE errors that bubble up from vscode-jsonrpc when the Copilot
// CLI subprocess exits before the SDK finishes writing to its stdin. These are
// expected during SDK init failures and are already handled by initCopilot's
// catch block — the unhandled rejection / uncaught exception is just the
// async write draining after the process is gone.
process.on('uncaughtException', (err) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
    console.warn('[main] Suppressed stream error (CLI subprocess likely exited):', err.message);
    return;
  }
  // Re-throw non-stream errors so Electron's default handler shows the dialog
  throw err;
});

process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error) {
    const code = (reason as NodeJS.ErrnoException).code;
    if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') {
      console.warn('[main] Suppressed unhandled stream rejection (CLI subprocess likely exited):', reason.message);
      return;
    }
  }
  // Log but don't crash for other unhandled rejections
  console.error('[main] Unhandled promise rejection:', reason);
});

/**
 * Register (or re-register) the global toggle-window shortcut.
 * Only unregisters the previous toggle shortcut (not all global shortcuts).
 * Returns true on success, false if the OS refused the binding.
 */
export function registerToggleShortcut(accelerator: string): boolean {
  const previousAccelerator = currentToggleAccelerator;
  if (previousAccelerator) {
    globalShortcut.unregister(previousAccelerator);
  }

  let registered = false;
  try {
    registered = globalShortcut.register(accelerator, () => toggleWindow('hotkey'));
  } catch (err) {
    console.warn(`[main] Invalid global shortcut "${accelerator}":`, err);
  }

  if (registered) {
    currentToggleAccelerator = accelerator;
    toggleShortcutRegistered = true;
  } else {
    console.warn(`[main] Failed to register global shortcut "${accelerator}" — another process may be holding it`);
    // Attempt to restore the previous shortcut
    if (previousAccelerator) {
      try {
        toggleShortcutRegistered = globalShortcut.register(previousAccelerator, () => toggleWindow('hotkey'));
      } catch (err) {
        console.warn(`[main] Failed to restore global shortcut "${previousAccelerator}":`, err);
        toggleShortcutRegistered = false;
      }
    } else {
      toggleShortcutRegistered = false;
    }
  }
  return registered;
}

// Register custom scheme as privileged (must happen before app ready)
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'copilot-whim',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// Canvas artifacts render on their own scheme, and therefore their own origin,
// so agent-authored HTML can never reach the app renderer's origin or storage.
registerArtifactSchemePrivileges();

app.whenReady().then(async () => {
  try {
  // Register custom protocol to serve renderer files (Web Speech API needs a real origin, not file://)
  // Also serves workspace attachment files via copilot-whim://app/workspace/<intentFolder>/<path>
  protocol.handle('copilot-whim', request => serveAppRequest(
    request, path.join(__dirname, '..', 'renderer'), getConfigValue('workspace'),
    url => net.fetch(url),
  ));

  // Serve canvas artifacts from an isolated session on their own origin.
  registerArtifactProtocol(resolveSpaceLocation);

  // Grant microphone permission for Web Speech API
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['media', 'audioCapture', 'microphone'];
    if (!allowed.includes(permission)) { callback(false); return; }
    if (process.platform === 'darwin') {
      void systemPreferences.askForMediaAccess('microphone').then(callback, error => {
        console.warn('[main] Microphone permission request failed:', error);
        callback(false);
      });
    } else callback(true);
  });

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    const allowed = ['media', 'audioCapture', 'microphone'];
    return allowed.includes(permission);
  });

  // Load local config and initialize workspace if configured
  const config = loadConfig();
  const workspace = config.workspace;

  if (workspace && !fs.existsSync(workspace)) {
    // Workspace path configured but directory missing — clear it
    console.warn(`[main] Workspace directory not found: ${workspace}`);
    setConfigValue('workspace', null);
  }
  // If no workspace, DB is not initialized — IPC handlers return empty/error states

  // Interfaces routinely change while the machine is asleep and the binder's
  // poll timer is suspended, so re-resolve immediately on resume.
  powerMonitor.on('resume', () => {
    void refreshWebRemoteBindings().catch((err) => {
      console.warn('[main] Failed to refresh web remote bindings after resume:', err);
    });
  });

  // ── Module initialization ──────────────────────────────
  const preloadPath = path.join(__dirname, 'preload.js');

  registerIpcHandlers();
  registerUpdateHandlers();
  registerIpcHandler('storage:status', () => getStorageReadiness());
  // Recovery runs in its worker concurrently with native window construction;
  // creating the capture shell must not serialize these independent cold starts.
  const storageOpening = workspace && fs.existsSync(workspace)
    ? (async () => {
      await initWorkspace(workspace);
      const migrated = await migrateOldDatabase(workspace, path.join(app.getPath('userData'), 'spaces.db'));
      if (migrated) {
        if (migrated.theme) setConfigValue('theme', migrated.theme);
        if (migrated.model) setConfigValue('model', migrated.model);
        config.sessions = { ...migrated.sessions, ...config.sessions };
        setConfigValue('sessions', config.sessions);
      }
      await initDatabase(getDbPath(workspace), getLogRoot(workspace));
    })().then(() => ({ ok: true as const }), error => ({ ok: false as const, error }))
    : undefined;
  const mainWin = createMainWindow({ preloadPath });
  // Register before any recovery work that may invoke a slow external auth
  // command. Otherwise the page can finish loading while startup is awaiting
  // recovery, causing this one-shot event to be missed.
  whenRendererReady(mainWin, () => {
    if (mainWin.isVisible()) {
      const side = (getConfigValue('snapPosition') || 'bottom-right').includes('left') ? 'left' : 'right';
      mainWin.webContents.send('window:shown', { side, expanded: false, source: 'startup' });
    } else toggleWindow('startup');
  });
  registerWindowIpcHandlers(preloadPath);
  setupSnapOnDrop();
  void createTray().catch(error => console.error('[main] Tray initialization failed:', error));
  const hotkeys = getResolvedHotkeys();
  registerToggleShortcut(hotkeys.toggleWindow);

  // The shell is already loading; only post-readiness services wait for recovery.
  let webStarted = false;
  if (workspace && storageOpening) {
    const opened = await storageOpening;
    if (!opened.ok) throw opened.error;
    webStarted = true;
    void syncWebRemoteServer().catch(error => console.error('[main] Web service failed:', error));
    await withWorkspaceContext(async () => {
      await mergeSessionIds(config.sessions);
      notifyAllWindows('workspace:changed', workspace);
      await syncCanvasContent(workspace);
      (await startSkillWatcher(workspace));
      (await startScheduler());
      startStorageMaintenance(workspace);
    });
  }
  if (!webStarted) void syncWebRemoteServer().catch(error => console.error('[main] Web service failed:', error));
  void initCopilot().catch(error => console.error('[main] Runtime initialization failed:', error));
  startCliExitMonitor();
  void restoreActiveCloudPollers().catch((err) => {
    console.warn('[main] Cloud poller recovery failed:', err);
  });
  (await reconcileStaleAgents());
  initAutoUpdater();

  // Dev mode: watch renderer files and auto-reload windows
  if (!app.isPackaged) {
    const rendererDir = path.join(__dirname, '..', 'renderer');
    fs.watch(rendererDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      console.log(`[dev] Renderer file changed: ${filename}, reloading...`);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.reload();
      }
    });
  }

  } catch (err) {
    console.error('[main] Fatal startup error:', err);
    dialog.showErrorBox('whim — Startup Error',
      `The app failed to initialize:\n\n${err instanceof Error ? err.message : String(err)}`);
    app.quit();
  }
});

let exitPrepared = false;
installLifecycleHandler(async () => {
  const resumeCommands = pauseWorkspaceCommands();
  const workspace = getConfigValue('workspace');
  const restoreWatchers = stopAllWatchers();
  let canResume = true;
  try {
  stopStorageMaintenance();
  stopSyncPolling();
  stopSkillWatcher();
  stopCliExitMonitor();
  stopAllCloudPollers();
  stopScheduler();
  await stopWebRemoteServer();
  await stopWorkspaceAgents();
  await shutdownCopilot();
  await drainProducers();
  await shutdownVoice();
  if (workspace) {
    try { await commitNow(workspace); }
    catch (error) { console.error('[main] Git checkpoint failed; durable local files retained:', error); }
  }
  await drainGitOperations();
  await closeDatabase();
  cleanupAutoUpdater();
  if (process.env.WHIM_PERF === '1') console.info('[perf]', getPerformanceTimings());
  globalShortcut.unregisterAll();
  destroyTray();
  exitPrepared = true;
  releaseSettingsWindow();
  releaseCanvasWindow();
  } catch (error) {
    if (getStorageReadiness().state !== 'ready') {
      canResume = false;
      console.error('[main] Shutdown failed after storage became unavailable:', error);
      throw new Error('Shutdown failed after storage became unavailable. Drafts are retained; copy them and restart before saving.');
    }
    try {
      await restartWorkspaceServices(workspace);
      await restoreWatchers();
      await syncWebRemoteServer();
    } catch (recoveryError) {
      canResume = false;
      console.error('[main] Shutdown failed:', error);
      console.error('[main] Shutdown recovery failed:', recoveryError);
      throw new Error('Shutdown recovery failed. Drafts are retained; copy them and restart before saving.');
    }
    throw error;
  } finally {
    if (!exitPrepared && canResume) resumeCommands();
  }
});

app.on('before-quit', event => {
  if (!exitPrepared) {
    event.preventDefault();
    void prepareShutdown('quit').then(() => app.quit()).catch(error => {
      console.error('[main] Shutdown cancelled:', error);
      dialog.showErrorBox('whim - Save before quitting', error instanceof Error ? error.message : String(error));
    });
    return;
  }
  // Let the settings + canvas windows' `close` handlers actually close them
  // now that the app is quitting (normally we intercept close to hide for
  // speed).
  releaseSettingsWindow();
  releaseCanvasWindow();
});

app.on('window-all-closed', () => {
  // Don't quit — the app stays alive in the system tray
  if (process.platform === 'darwin') {
    // On macOS this is standard behavior (app stays in dock)
  }
});
