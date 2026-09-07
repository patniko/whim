import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ── Capture handlers registered via ipcMain.handle / ipcMain.on ─────
const handleHandlers = new Map<string, Function>();
const onHandlers = new Map<string, Function>();

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/space-test' },
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => {
      handleHandlers.set(channel, handler);
    }),
    on: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: () => mockWindows,
    fromWebContents: () => null,
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn() },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('../storage', async () => ({
  ...(await import('../workspace')),
  ...(await import('../services/skill-schedule-store')),
  ...(await import('../canvas/artifact-store')),
  documentMatches: (await import('../storage-documents')).documentMatches,
  getStorageGeneration: () => 0,
  withWorkspaceContext: (run: () => unknown) => run(),
  withStorageGeneration: (_generation: number, run: () => unknown) => run(),

  isInitialized: vi.fn(() => true),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  mergeSessionIds: vi.fn(),
  syncCanvasContent: vi.fn(),
}));

vi.mock('../config', () => ({
  getConfig: vi.fn(() => ({ workspace: '/mock/workspace', sessions: {} })),
  getConfigValue: vi.fn((key: string) => {
    if (key === 'workspace') return '/mock/workspace';
    return null;
  }),
  setConfigValue: vi.fn(),
  getProfiles: vi.fn(() => []),
  getActiveProfileId: vi.fn(() => null),
  getProfileById: vi.fn(() => null),
  getNextProfile: vi.fn(() => null),
  upsertProfileForPath: vi.fn((dir: string) => ({ id: 'p1', path: dir, name: null, tint: null })),
  setActiveProfile: vi.fn(),
  updateProfile: vi.fn((id: string) => ({ id, path: '/mock/workspace', name: null, tint: null })),
  removeProfileById: vi.fn(),
}));

vi.mock('../workspace', () => ({
  initWorkspace: vi.fn(),
  getDbPath: vi.fn((dir: string) => `${dir}/.whim/spaces.db`),
  getLogRoot: vi.fn((dir: string) => `${dir}/.whim/events`),
  getGitSyncStatus: vi.fn(async () => ({ available: true, branch: 'main', ahead: 0, behind: 0 })),
  gitFetchOrigin: vi.fn(async () => {}),
  gitPush: vi.fn(async () => ({ ok: true })),
  gitPull: vi.fn(async () => ({ ok: true })),
  getDefaultProfileName: vi.fn(async () => 'repo'),
  invalidateProfileNameCache: vi.fn(),
  cancelGitPolling: vi.fn(),
  drainGitOperations: vi.fn(),
}));
vi.mock('../lifecycle', () => ({ flushEditors: vi.fn(async () => vi.fn()) }));
vi.mock('../ai', () => ({ shutdownCopilot: vi.fn(), initCopilot: vi.fn() }));
vi.mock('../agent-service', () => ({
  stopCliExitMonitor: vi.fn(), startCliExitMonitor: vi.fn(),
  stopWorkspaceAgents: vi.fn(), clearWorkspaceAgentState: vi.fn(),
}));
vi.mock('../cloud-agent-poller', () => ({ stopAllCloudPollers: vi.fn(), restoreActiveCloudPollers: vi.fn() }));
vi.mock('../services/scheduler', () => ({ stopScheduler: vi.fn(), startScheduler: vi.fn() }));
vi.mock('../window-manager', () => ({ destroySettingsWindow: vi.fn(), destroyCanvasWindow: vi.fn() }));

vi.mock('../skill-watcher', () => ({
  startSkillWatcher: vi.fn(),
  stopSkillWatcher: vi.fn(),
}));

vi.mock('../session', () => ({
  launchSession: vi.fn(async () => ({ success: true })),
  getActiveSessionIntentIds: vi.fn(() => []),
}));

vi.mock('../voice', () => ({
  transcribeAudio: vi.fn(async () => 'transcribed text'),
}));

// ── Import after mocks ─────────────────────────────────────────────
import { registerWorkspaceHandlers } from '../../main/ipc/workspace-handlers';
import * as fs from 'fs';
import { closeDatabase, initDatabase, mergeSessionIds, syncCanvasContent } from '../storage';
import { setConfigValue, getConfig, getProfiles, getActiveProfileId, getProfileById, getNextProfile, upsertProfileForPath, setActiveProfile, updateProfile, removeProfileById } from '../config';
import { initWorkspace, getGitSyncStatus, gitPush, gitPull } from '../workspace';
import { startSkillWatcher, stopSkillWatcher } from '../skill-watcher';
import { dialog, BrowserWindow } from 'electron';
import { flushEditors } from '../lifecycle';

const fakeEvent = { sender: { id: 1 } } as any;

// Track webContents.send calls per window
const mockSend = vi.fn();
const mockWindows = [{ webContents: { send: mockSend } }];

function invoke(channel: string, ...args: any[]) {
  const handler = handleHandlers.get(channel);
  if (!handler) throw new Error(`No handler registered for "${channel}"`);
  return handler(fakeEvent, ...args);
}

describe('workspace handlers', () => {
  beforeAll(() => {
    registerWorkspaceHandlers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true as any);
  });

  it('keeps the old profile and workspace intact when editor flushing fails', async () => {
    vi.mocked(getProfileById).mockReturnValueOnce({ id: 'new', path: '/new', name: null, tint: null });
    vi.mocked(flushEditors).mockRejectedValueOnce(new Error('Unsaved conflict'));
    await expect(invoke('profiles:activate', 'new')).rejects.toThrow('Unsaved conflict');
    expect(setActiveProfile).not.toHaveBeenCalled();
    expect(setConfigValue).not.toHaveBeenCalled();
    expect(closeDatabase).not.toHaveBeenCalled();
  });

  it('flushes before changing profile configuration and restores the old database on initialization failure', async () => {
    vi.mocked(getProfileById).mockReturnValueOnce({ id: 'new', path: '/new', name: null, tint: null });
    vi.mocked(initDatabase).mockRejectedValueOnce(new Error('Recovery failed'));
    await expect(invoke('profiles:activate', 'new')).rejects.toThrow('Recovery failed');
    expect(setActiveProfile).not.toHaveBeenCalledWith('new');
    expect(setConfigValue).not.toHaveBeenCalledWith('workspace', '/new');
    expect(initDatabase).toHaveBeenLastCalledWith('/mock/workspace/.whim/spaces.db', '/mock/workspace/.whim/events');
  });

  describe('workspace:clear', () => {
    it('stops skill watcher', async () => {
      await invoke('workspace:clear');
      expect(stopSkillWatcher).toHaveBeenCalled();
    });

    it('closes the database', async () => {
      await invoke('workspace:clear');
      expect(closeDatabase).toHaveBeenCalled();
    });

    it('clears workspace config', async () => {
      await invoke('workspace:clear');
      expect(setConfigValue).toHaveBeenCalledWith('workspace', null);
    });

    it('sends workspace:changed with null to all windows', async () => {
      await invoke('workspace:clear');
      expect(mockSend).toHaveBeenCalledWith('workspace:changed', null);
    });

    it('returns ok', async () => {
      const result = await invoke('workspace:clear');
      expect(result).toEqual({ ok: true });
    });
  });

  describe('workspace:select', () => {
    it('closes old DB before initializing new workspace', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/new/workspace'],
      } as any);

      const callOrder: string[] = [];
      vi.mocked(stopSkillWatcher).mockImplementation(() => { callOrder.push('stop'); });
      vi.mocked(closeDatabase).mockImplementation(async () => { callOrder.push('close'); });
      vi.mocked(initWorkspace).mockImplementation(() => { callOrder.push('init-ws'); });
      vi.mocked(initDatabase).mockImplementation(async () => { callOrder.push('init-db'); });

      await invoke('workspace:select');

      expect(callOrder).toEqual(['stop', 'close', 'init-ws', 'init-db']);
    });

    it('sends workspace:changed event after selection', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/new/workspace'],
      } as any);

      await invoke('workspace:select');

      expect(mockSend).toHaveBeenCalledWith('workspace:changed', '/new/workspace');
    });

    it('saves workspace to config', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/new/workspace'],
      } as any);

      await invoke('workspace:select');

      expect(setConfigValue).toHaveBeenCalledWith('workspace', '/new/workspace');
    });

    it('starts skill watcher for new workspace', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/new/workspace'],
      } as any);

      await invoke('workspace:select');

      expect(startSkillWatcher).toHaveBeenCalledWith('/new/workspace');
    });

    it('returns selected: false when dialog is canceled', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      } as any);

      const result = await invoke('workspace:select');

      expect(result).toEqual({ selected: false, path: null });
      expect(closeDatabase).not.toHaveBeenCalled();
    });
  });

  describe('workspace:git-status', () => {
    it('returns sync status from workspace', async () => {
      const result = await invoke('workspace:git-status');
      expect(result).toEqual({ available: true, branch: 'main', ahead: 0, behind: 0 });
      expect(getGitSyncStatus).toHaveBeenCalledWith('/mock/workspace');
    });
  });

  describe('workspace:git-push', () => {
    it('calls gitPush with workspace path', async () => {
      const result = await invoke('workspace:git-push');
      expect(result).toEqual({ ok: true });
      expect(gitPush).toHaveBeenCalledWith('/mock/workspace');
    });

    it('returns error when push fails', async () => {
      vi.mocked(gitPush).mockResolvedValueOnce({ error: 'Push rejected' });
      const result = await invoke('workspace:git-push');
      expect(result).toEqual({ error: 'Push rejected' });
    });
  });

  describe('workspace:git-pull', () => {
    it('calls gitPull with workspace path', async () => {
      const result = await invoke('workspace:git-pull');
      expect(result).toEqual({ ok: true });
      expect(gitPull).toHaveBeenCalledWith('/mock/workspace');
    });

    it('returns conflict flag when branches diverged', async () => {
      vi.mocked(gitPull).mockResolvedValueOnce({ error: 'diverged', conflict: true });
      const result = await invoke('workspace:git-pull');
      expect(result).toEqual({ error: 'diverged', conflict: true });
    });
  });

  describe('profiles:list', () => {
    it('returns resolved profiles with display names + active id', async () => {
      vi.mocked(getProfiles).mockReturnValueOnce([
        { id: 'a', path: '/work', name: 'Work', tint: '#7c66dc' },
        { id: 'b', path: '/personal', name: null, tint: null },
      ] as any);
      vi.mocked(getActiveProfileId).mockReturnValueOnce('a');

      const result = await invoke('profiles:list');
      expect(result.activeProfileId).toBe('a');
      expect(result.profiles).toHaveLength(2);
      expect(result.profiles[0].displayName).toBe('Work');   // name override wins
      expect(result.profiles[1].displayName).toBe('repo');   // from getDefaultProfileName mock
    });
  });

  describe('profiles:activate', () => {
    it('switches the DB to the profile path and broadcasts', async () => {
      vi.mocked(getProfileById).mockReturnValueOnce({ id: 'b', path: '/personal', name: null, tint: null } as any);

      const result = await invoke('profiles:activate', 'b');
      expect(result).toEqual({ ok: true });
      expect(closeDatabase).toHaveBeenCalled();
      expect(initDatabase).toHaveBeenCalled();
      expect(setActiveProfile).toHaveBeenCalledWith('b');
      expect(mockSend).toHaveBeenCalledWith('workspace:changed', '/personal');
      expect(mockSend).toHaveBeenCalledWith('profiles:changed', expect.anything());
    });

    it('returns not_found for an unknown profile', async () => {
      vi.mocked(getProfileById).mockReturnValueOnce(null as any);
      const result = await invoke('profiles:activate', 'missing');
      expect(result).toEqual({ ok: false, error: 'not_found' });
      expect(closeDatabase).not.toHaveBeenCalled();
    });

    it('returns missing_path when the folder no longer exists', async () => {
      vi.mocked(getProfileById).mockReturnValueOnce({ id: 'b', path: '/gone', name: null, tint: null } as any);
      vi.mocked(fs.existsSync).mockReturnValueOnce(false as any);
      const result = await invoke('profiles:activate', 'b');
      expect(result).toEqual({ ok: false, error: 'missing_path' });
      expect(closeDatabase).not.toHaveBeenCalled();
    });

    it('is a no-op when the profile is already active', async () => {
      vi.mocked(getProfileById).mockReturnValueOnce({ id: 'a', path: '/work', name: null, tint: null } as any);
      vi.mocked(getActiveProfileId).mockReturnValueOnce('a');
      const result = await invoke('profiles:activate', 'a');
      expect(result).toEqual({ ok: true });
      expect(closeDatabase).not.toHaveBeenCalled();
    });
  });

  describe('profiles:cycle', () => {
    it('activates the next profile in order', async () => {
      vi.mocked(getNextProfile).mockReturnValueOnce({ id: 'b', path: '/personal', name: null, tint: null } as any);
      const result = await invoke('profiles:cycle');
      expect(result).toEqual({ ok: true, profileId: 'b' });
      expect(setActiveProfile).toHaveBeenCalledWith('b');
      expect(initDatabase).toHaveBeenCalled();
    });

    it('returns ok:false when there is nothing to cycle to', async () => {
      vi.mocked(getNextProfile).mockReturnValueOnce(null as any);
      const result = await invoke('profiles:cycle');
      expect(result).toEqual({ ok: false });
      expect(closeDatabase).not.toHaveBeenCalled();
    });
  });

  describe('profiles:update', () => {
    it('updates a profile and broadcasts', async () => {
      vi.mocked(updateProfile).mockReturnValueOnce({ id: 'a', path: '/work', name: 'Work', tint: '#abcdef' } as any);
      const result = await invoke('profiles:update', 'a', { tint: '#abcdef' });
      expect(result).toEqual({ ok: true });
      expect(updateProfile).toHaveBeenCalledWith('a', { tint: '#abcdef' });
      expect(mockSend).toHaveBeenCalledWith('profiles:changed', expect.anything());
    });

    it('returns ok:false for an unknown profile', async () => {
      vi.mocked(updateProfile).mockReturnValueOnce(null as any);
      const result = await invoke('profiles:update', 'missing', { name: 'x' });
      expect(result).toEqual({ ok: false });
    });
  });

  describe('profiles:remove', () => {
    it('removes and switches to a remaining profile when the active one is removed', async () => {
      vi.mocked(getActiveProfileId).mockReturnValueOnce('a');
      vi.mocked(getProfiles).mockReturnValueOnce([{ id: 'b', path: '/personal', name: null, tint: null }] as any);
      const result = await invoke('profiles:remove', 'a');
      expect(result).toEqual({ ok: true });
      expect(removeProfileById).toHaveBeenCalledWith('a');
      expect(setActiveProfile).toHaveBeenCalledWith('b');
      expect(initDatabase).toHaveBeenCalled();
    });

    it('goes to fresh-start when the last profile is removed', async () => {
      vi.mocked(getActiveProfileId).mockReturnValueOnce('a');
      vi.mocked(getProfiles).mockReturnValueOnce([] as any);
      const result = await invoke('profiles:remove', 'a');
      expect(result).toEqual({ ok: true });
      expect(setConfigValue).toHaveBeenCalledWith('workspace', null);
      expect(mockSend).toHaveBeenCalledWith('workspace:changed', null);
    });

    it('skips missing fallback profile paths when the active profile is removed', async () => {
      vi.mocked(getActiveProfileId).mockReturnValueOnce('a');
      vi.mocked(getProfiles).mockReturnValueOnce([
        { id: 'missing', path: '/gone', name: null, tint: null },
        { id: 'b', path: '/personal', name: null, tint: null },
      ] as any);
      vi.mocked(fs.existsSync).mockImplementation((p) => p === '/personal');

      const result = await invoke('profiles:remove', 'a');

      expect(result).toEqual({ ok: true });
      expect(setActiveProfile).toHaveBeenCalledWith('b');
      expect(setConfigValue).toHaveBeenCalledWith('workspace', '/personal');
      expect(setConfigValue).not.toHaveBeenCalledWith('workspace', '/gone');
    });

    it('goes to fresh-start when remaining profile paths are missing', async () => {
      vi.mocked(getActiveProfileId).mockReturnValueOnce('a');
      vi.mocked(getProfiles).mockReturnValueOnce([{ id: 'missing', path: '/gone', name: null, tint: null }] as any);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await invoke('profiles:remove', 'a');

      expect(result).toEqual({ ok: true });
      expect(setConfigValue).toHaveBeenCalledWith('workspace', null);
      expect(setActiveProfile).toHaveBeenCalledWith(null);
      expect(mockSend).toHaveBeenCalledWith('workspace:changed', null);
    });
  });

  describe('profiles:add', () => {
    it('adds + activates the chosen directory', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: false, filePaths: ['/added'] } as any);
      const result = await invoke('profiles:add');
      expect(result).toEqual({ added: true, profileId: 'p1' });
      expect(upsertProfileForPath).toHaveBeenCalledWith('/added');
      expect(initDatabase).toHaveBeenCalled();
    });

    it('returns added:false when the dialog is canceled', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({ canceled: true, filePaths: [] } as any);
      const result = await invoke('profiles:add');
      expect(result).toEqual({ added: false, profileId: null });
      expect(initDatabase).not.toHaveBeenCalled();
    });
  });
});
