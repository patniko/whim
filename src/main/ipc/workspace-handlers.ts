import { registerIpcHandler } from './registry';
import { BrowserWindow, shell } from 'electron';
import * as fs from 'fs';
import { isInitialized, closeDatabase } from '../storage';
import { launchSession, getActiveSessionIntentIds } from '../session';
import { transcribeAudio } from '../voice';
import {
  getConfigValue, setConfigValue, getConfig,
  getProfiles, getActiveProfileId, getProfileById, getNextProfile,
  upsertProfileForPath, setActiveProfile, updateProfile, removeProfileById,
} from '../config';
import { getDbPath, getLogRoot, getGitSyncStatus, gitFetchOrigin, gitPush, gitPull, getDefaultProfileName, invalidateProfileNameCache, cancelGitPolling, drainGitOperations } from '../workspace';
import { initWorkspace, initDatabase, mergeSessionIds, syncCanvasContent, withWorkspaceContext } from '../storage';
import { startSkillWatcher, stopSkillWatcher } from '../skill-watcher';
import { destroySettingsWindow, destroyCanvasWindow } from '../window-manager';
import { mirrorRendererEvent } from '../web/event-hub';
import type { GitSyncStatus, ProfilesState } from '../../shared/ipc-contract';
import { showOpenDialog } from './dialog-utils';
import { flushEditors } from '../lifecycle';
import { stopScheduler, startScheduler } from '../services/scheduler';
import { stopAllWatchers } from '../canvas-watcher';
import { pauseWorkspaceCommands, drainProducers } from '../producer-tasks';
import { shutdownCopilot, initCopilot } from '../ai';
import { stopAllCloudPollers, restoreActiveCloudPollers } from '../cloud-agent-poller';
import { stopCliExitMonitor, startCliExitMonitor, stopWorkspaceAgents, clearWorkspaceAgentState } from '../agent-service';
import { startStorageMaintenance, stopStorageMaintenance } from '../storage-maintenance';
import { notifyAllWindows } from '../notify';

// ── Git sync polling ────────────────────────────────────
const GIT_SYNC_POLL_MS = 60_000;
let syncPollTimer: ReturnType<typeof setInterval> | null = null;
let lastSyncStatus: GitSyncStatus | null = null;
let pollGeneration = 0;
let polling = false;
let failures = 0;

function broadcastSyncStatus(status: GitSyncStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('workspace:git-sync-changed', status);
  }
  mirrorRendererEvent('workspace:git-sync-changed', status);
}

async function pollGitSync(): Promise<void> {
  const workspace = getConfigValue('workspace');
  if (!workspace || polling) return;
  polling = true;
  const current = pollGeneration;

  try {
  try {
    await gitFetchOrigin(workspace, true);
    failures = 0;
  } catch {
    failures = Math.min(failures + 1, 6);
    if (process.env.WHIM_PERF === '1') console.info('[perf:git-poll]', { failures });
  }
  if (current !== pollGeneration || workspace !== getConfigValue('workspace')) return;

  try {
    const status = await getGitSyncStatus(workspace);
    if (current !== pollGeneration) return;
    // Broadcast only when status actually changes
    if (!lastSyncStatus
      || lastSyncStatus.ahead !== status.ahead
      || lastSyncStatus.behind !== status.behind
      || lastSyncStatus.available !== status.available
      || lastSyncStatus.branch !== status.branch
    ) {
      lastSyncStatus = status;
      broadcastSyncStatus(status);
    }
  } catch (error) {
    console.warn('[workspace] Git status failed:', error);
  }
  } finally {
    polling = false;
    if (current === pollGeneration) {
      syncPollTimer = setTimeout(() => { void pollGitSync(); }, GIT_SYNC_POLL_MS * 2 ** failures);
    }
  }
}

function startSyncPolling(): void {
  stopSyncPolling();
  // Initial poll after a short delay to let workspace init finish
  syncPollTimer = setTimeout(() => { void pollGitSync(); }, 2000);
}

export function stopSyncPolling(): void {
  pollGeneration++;
  cancelGitPolling();
  if (syncPollTimer) {
    clearTimeout(syncPollTimer);
    syncPollTimer = null;
  }
  lastSyncStatus = null;
  failures = 0;
}

// ── Workspace open / profile helpers ────────────────────

/**
 * Tear down the current workspace and bring up `dir`: close the DB, re-init
 * workspace + DB + watchers, sync canvases, schedule compaction, refresh
 * pre-warmed popouts, broadcast `workspace:changed`, and (re)start git polling.
 * Mirrors `dir` into `config.workspace`.
 */
async function openWorkspace(dir: string | null, profileId: string | null = null): Promise<void> {
  const release = await flushEditors('workspace');
  const previousDir = getConfigValue('workspace');
  const previousProfile = getActiveProfileId();
  let resume: (() => void) | undefined;
  let closed = false;
  try {
  resume = pauseWorkspaceCommands();
  stopStorageMaintenance();
  stopAllCloudPollers();
  stopCliExitMonitor();
  stopSkillWatcher();
  stopSyncPolling();
  stopScheduler();
  stopAllWatchers();
  await stopWorkspaceAgents();
  await shutdownCopilot();
  await drainProducers();
  clearWorkspaceAgentState();
  await drainGitOperations();
  await closeDatabase();
  closed = true;
  await initializeWorkspace(dir);
  setActiveProfile(profileId);
  setConfigValue('workspace', dir);
  await restartWorkspaceServices(dir);

  // Destroy any pre-warmed settings + canvas windows so their next opens
  // cold-start fresh renderers with up-to-date workspace data.
  destroySettingsWindow();
  destroyCanvasWindow();

  // Notify all windows to reload data
  withWorkspaceContext(() => notifyAllWindows('workspace:changed', dir));

  } catch (error) {
    if (resume) {
      try {
        if (closed) {
          await withWorkspaceContext(() => closeDatabase());
          await initializeWorkspace(previousDir);
        }
        setActiveProfile(previousProfile);
        setConfigValue('workspace', previousDir);
        await restartWorkspaceServices(previousDir);
      } catch (recoveryError) {
        console.error('[workspace] Switch failed:', error);
        console.error('[workspace] Restoration failed:', recoveryError);
        throw new Error('Workspace switch and restoration failed; drafts retained. Restart before saving.');
      }
    }
    throw error;
  } finally { resume?.(); release(); }
}

async function initializeWorkspace(dir: string | null): Promise<void> {
  if (!dir) return;
  await withWorkspaceContext(async () => {
    await initWorkspace(dir);
    await initDatabase(getDbPath(dir), getLogRoot(dir));
  });
  await withWorkspaceContext(async () => {
    await mergeSessionIds(getConfig().sessions);
    await syncCanvasContent(dir);
  });
}

export async function restartWorkspaceServices(dir: string | null): Promise<void> {
  await withWorkspaceContext(async () => {
    if (dir) {
      await startSkillWatcher(dir);
      await startScheduler();
      startStorageMaintenance(dir);
      startSyncPolling();
      await restoreActiveCloudPollers();
    }
    startCliExitMonitor();
    await initCopilot();
  });
}

async function enterFreshStartWorkspaceState(): Promise<void> {
  await openWorkspace(null);
}

/** Resolve the renderer-facing profile list (with computed display names). */
async function buildProfilesState(): Promise<ProfilesState> {
  const profiles = getProfiles();
  const resolved = await Promise.all(profiles.map(async (p) => ({
    id: p.id,
    path: p.path,
    name: p.name,
    displayName: p.name ?? await getDefaultProfileName(p.path),
    tint: p.tint,
  })));
  return { profiles: resolved, activeProfileId: getActiveProfileId() };
}

async function broadcastProfilesChanged(): Promise<void> {
  const state = await buildProfilesState();
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('profiles:changed', state);
  }
}

/**
 * Show the directory picker, suppressing the main window's blur-hide while the
 * native dialog is open and restoring it afterward. Returns the chosen path or
 * null when canceled.
 */
async function pickDirectory(event: Electron.IpcMainInvokeEvent): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(event.sender);

  // Suppress blur-hide while dialog is open
  if (win) {
    win.removeAllListeners('blur');
  }

  try {
    const dialogOpts = {
      title: 'Select Workspace Directory',
      properties: ['openDirectory'] as Array<'openDirectory'>,
      defaultPath: getConfigValue('workspace') || undefined,
    };
    const result = await showOpenDialog(win, dialogOpts);

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  } finally {
    // Restore blur-hide behavior
    if (win) {
      const restoreTs = Date.now();
      win.on('blur', async () => {
        if (Date.now() - restoreTs < 300) return;
        try {
          const shouldStay = await win.webContents.executeJavaScript(
            `(function() {
              var input = document.getElementById('description-input');
              var hasInput = input && input.value.trim().length > 0;
              var canvasOpen = !document.getElementById('canvas-view').classList.contains('hidden');
              return hasInput || canvasOpen;
            })()`
          );
          if (shouldStay) return;
        } catch { /* hide on failure */ }
        win.hide();
      });
    }
  }
}

export function registerWorkspaceHandlers(): void {
  // Workspace directory picker — adds/activates a profile + initializes DB
  registerIpcHandler('workspace:select', async (event) => {
    const dir = await pickDirectory(event);
    if (!dir) {
      return { selected: false, path: null };
    }

    // Record (or reuse) a profile for this directory and make it active.
    const profile = upsertProfileForPath(dir);
    await openWorkspace(dir, profile.id);
    await broadcastProfilesChanged();

    return { selected: true, path: dir };
  });

  // Open a folder in the system file manager
  registerIpcHandler('shell:openPath', (_event, folderPath: string) => {
    return shell.openPath(folderPath);
  });

  // Open a URL in the user's default browser
  registerIpcHandler('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
    return { ok: true };
  });

  // Session launch
  registerIpcHandler('session:launch', async (_event, spaceId: string) => {
    const workspace = getConfigValue('workspace');
    if (!workspace || !fs.existsSync(workspace)) {
      return { success: false, error: 'no_workspace' };
    }
    if (!isInitialized()) {
      return { success: false, error: 'no_workspace' };
    }
    return (await launchSession(spaceId, workspace));
  });

  // Query which intents have active running terminal processes
  registerIpcHandler('session:active-spaces', () => {
    return getActiveSessionIntentIds();
  });

  registerIpcHandler('voice:transcribe', async (_event, audioData: number[]) => {
    return transcribeAudio(audioData);
  });

  // Clear workspace — returns app to a persistent fresh-start state while
  // keeping saved profiles available for later activation.
  registerIpcHandler('workspace:clear', async () => {
    (await enterFreshStartWorkspaceState());
    await broadcastProfilesChanged();

    return { ok: true };
  });

  // ── Workspace profile handlers ─────────────────────────

  registerIpcHandler('profiles:list', async () => {
    return buildProfilesState();
  });

  // Pick a directory, add it as a profile, and switch to it.
  registerIpcHandler('profiles:add', async (event) => {
    const dir = await pickDirectory(event);
    if (!dir) return { added: false, profileId: null };

    const profile = upsertProfileForPath(dir);
    await openWorkspace(dir, profile.id);
    await broadcastProfilesChanged();
    return { added: true, profileId: profile.id };
  });

  // Switch to an existing profile by id.
  registerIpcHandler('profiles:activate', async (_event, id: string) => {
    const profile = getProfileById(id);
    if (!profile) return { ok: false, error: 'not_found' };
    if (!fs.existsSync(profile.path)) return { ok: false, error: 'missing_path' };
    if (getActiveProfileId() === id) return { ok: true };

    await openWorkspace(profile.path, id);
    await broadcastProfilesChanged();
    return { ok: true };
  });

  // Cycle to the next profile in order (used by the logo + hotkey).
  registerIpcHandler('profiles:cycle', async () => {
    const next = getNextProfile();
    if (!next) return { ok: false };
    if (!fs.existsSync(next.path)) return { ok: false };

    await openWorkspace(next.path, next.id);
    await broadcastProfilesChanged();
    return { ok: true, profileId: next.id };
  });

  // Update a profile's name override and/or tint color.
  registerIpcHandler('profiles:update', async (_event, id: string, patch: { name?: string | null; tint?: string | null }) => {
    const updated = updateProfile(id, patch || {});
    if (!updated) return { ok: false };
    if ('name' in (patch || {})) invalidateProfileNameCache(updated.path);
    await broadcastProfilesChanged();
    return { ok: true };
  });

  // Remove a profile. If it was active, switch to another or go fresh-start.
  registerIpcHandler('profiles:remove', async (_event, id: string) => {
    const wasActive = getActiveProfileId() === id;
    if (wasActive) {
      const remaining = getProfiles().filter(profile => profile.id !== id);
      const fallback = remaining.find(profile => fs.existsSync(profile.path));
      if (fallback) {
        await openWorkspace(fallback.path, fallback.id);
      } else {
        (await enterFreshStartWorkspaceState());
      }
      removeProfileById(id);
    }

    await broadcastProfilesChanged();
    return { ok: true };
  });

  // ── Git sync handlers ──────────────────────────────────

  registerIpcHandler('workspace:git-status', async () => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { available: false, branch: null, ahead: 0, behind: 0, unavailableReason: 'not-a-repo' as const };
    return getGitSyncStatus(workspace);
  });

  registerIpcHandler('workspace:git-push', async () => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { error: 'No workspace selected' };
    const result = await gitPush(workspace);
    // Refresh status after push
    pollGitSync();
    return result;
  });

  registerIpcHandler('workspace:git-pull', async () => {
    const workspace = getConfigValue('workspace');
    if (!workspace) return { error: 'No workspace selected' };
    const result = await gitPull(workspace);
    // Refresh status after pull
    pollGitSync();
    return result;
  });

  // Start polling if workspace is already configured on startup
  if (getConfigValue('workspace')) {
    startSyncPolling();
  }
}
