import { registerIpcHandler } from './registry';
import { BrowserWindow, shell } from 'electron';
import * as fs from 'fs';
import { isInitialized, closeDatabase } from '../database';
import { launchSession, getActiveSessionIntentIds } from '../session';
import { transcribeAudio } from '../voice';
import {
  getConfigValue, setConfigValue, getConfig,
  getProfiles, getActiveProfileId, getProfileById, getNextProfile,
  upsertProfileForPath, setActiveProfile, updateProfile, removeProfileById,
} from '../config';
import { initWorkspace, getDbPath, getLogRoot, getGitSyncStatus, gitFetchOrigin, gitPush, gitPull, getDefaultProfileName, invalidateProfileNameCache } from '../workspace';
import { initDatabase, mergeSessionIds, syncCanvasContent } from '../database';
import { compactOldSegments } from '../compaction';
import { startSkillWatcher, stopSkillWatcher } from '../skill-watcher';
import { destroySettingsWindow, destroyCanvasWindow } from '../window-manager';
import { mirrorRendererEvent } from '../web/event-hub';
import type { GitSyncStatus, ProfilesState } from '../../shared/ipc-contract';
import { showOpenDialog } from './dialog-utils';

// ── Git sync polling ────────────────────────────────────
const GIT_SYNC_POLL_MS = 60_000;
let syncPollTimer: ReturnType<typeof setInterval> | null = null;
let lastSyncStatus: GitSyncStatus | null = null;

function broadcastSyncStatus(status: GitSyncStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('workspace:git-sync-changed', status);
  }
  mirrorRendererEvent('workspace:git-sync-changed', status);
}

async function pollGitSync(): Promise<void> {
  const workspace = getConfigValue('workspace');
  if (!workspace) return;

  try {
    await gitFetchOrigin(workspace);
  } catch {
    // Network may be unavailable — still check local status
  }

  try {
    const status = await getGitSyncStatus(workspace);
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
  } catch {
    // Silently skip
  }
}

function startSyncPolling(): void {
  stopSyncPolling();
  // Initial poll after a short delay to let workspace init finish
  setTimeout(() => pollGitSync(), 2000);
  syncPollTimer = setInterval(() => pollGitSync(), GIT_SYNC_POLL_MS);
}

function stopSyncPolling(): void {
  if (syncPollTimer) {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
  }
  lastSyncStatus = null;
}

// ── Workspace open / profile helpers ────────────────────

/**
 * Tear down the current workspace and bring up `dir`: close the DB, re-init
 * workspace + DB + watchers, sync canvases, schedule compaction, refresh
 * pre-warmed popouts, broadcast `workspace:changed`, and (re)start git polling.
 * Mirrors `dir` into `config.workspace`.
 */
function openWorkspace(dir: string): void {
  // Close previous workspace cleanly
  stopSkillWatcher();
  closeDatabase();

  setConfigValue('workspace', dir);

  // Initialize workspace structure and DB
  initWorkspace(dir);
  initDatabase(getDbPath(dir), getLogRoot(dir));
  mergeSessionIds(getConfig().sessions);
  syncCanvasContent(dir);
  startSkillWatcher(dir);

  // Opportunistic compaction for the newly-opened workspace — deferred to idle
  // so the switch UX feels instant. Cheap when nothing is cold.
  setTimeout(() => {
    try { compactOldSegments(getLogRoot(dir)); }
    catch (err) { console.warn('[workspace] Compaction failed:', err); }
  }, 5000).unref();

  // Destroy any pre-warmed settings + canvas windows so their next opens
  // cold-start fresh renderers with up-to-date workspace data.
  destroySettingsWindow();
  destroyCanvasWindow();

  // Notify all windows to reload data
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('workspace:changed', dir);
  }

  // Start git sync polling for the new workspace
  startSyncPolling();
}

function enterFreshStartWorkspaceState(): void {
  stopSkillWatcher();
  stopSyncPolling();
  closeDatabase();
  setConfigValue('workspace', null);
  setActiveProfile(null);
  destroySettingsWindow();
  destroyCanvasWindow();
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('workspace:changed', null);
  }
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
    setActiveProfile(profile.id);

    openWorkspace(dir);
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
    return launchSession(spaceId, workspace);
  });

  // Query which intents have active running terminal processes
  registerIpcHandler('session:active-spaces', () => {
    return getActiveSessionIntentIds();
  });

  registerIpcHandler('voice:transcribe', async (_event, audioData: number[]) => {
    const float32 = new Float32Array(audioData);
    return transcribeAudio(float32);
  });

  // Clear workspace — returns app to a persistent fresh-start state while
  // keeping saved profiles available for later activation.
  registerIpcHandler('workspace:clear', async () => {
    enterFreshStartWorkspaceState();
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
    setActiveProfile(profile.id);
    openWorkspace(dir);
    await broadcastProfilesChanged();
    return { added: true, profileId: profile.id };
  });

  // Switch to an existing profile by id.
  registerIpcHandler('profiles:activate', async (_event, id: string) => {
    const profile = getProfileById(id);
    if (!profile) return { ok: false, error: 'not_found' };
    if (!fs.existsSync(profile.path)) return { ok: false, error: 'missing_path' };
    if (getActiveProfileId() === id) return { ok: true };

    setActiveProfile(id);
    openWorkspace(profile.path);
    await broadcastProfilesChanged();
    return { ok: true };
  });

  // Cycle to the next profile in order (used by the logo + hotkey).
  registerIpcHandler('profiles:cycle', async () => {
    const next = getNextProfile();
    if (!next) return { ok: false };
    if (!fs.existsSync(next.path)) return { ok: false };

    setActiveProfile(next.id);
    openWorkspace(next.path);
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
    removeProfileById(id);

    if (wasActive) {
      const remaining = getProfiles();
      const fallback = remaining.find(profile => fs.existsSync(profile.path));
      if (fallback) {
        setActiveProfile(fallback.id);
        openWorkspace(fallback.path);
      } else {
        enterFreshStartWorkspaceState();
      }
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
