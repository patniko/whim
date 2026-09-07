import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';

// Mock electron before importing config
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/space-test-config',
  },
}));

import { loadConfig, getConfig, getConfigValue, setConfigValue, getSessionId, setSessionId, removeSession, saveConfig, DEFAULT_WEB_REMOTE_PORT, DEFAULT_HOTKEYS, getProfiles, getActiveProfile, getActiveProfileId, getProfileById, upsertProfileForPath, updateProfile, removeProfileById, setActiveProfile, getNextProfile, generateProfileId, getExportDestinations, setExportDestinations, validateExportDestinations, getExportDestinationById, generateExportDestinationId } from './config';

const CONFIG_PATH = path.join('/tmp/space-test-config', 'config.json');

describe('config', () => {
  beforeEach(() => {
    // Clean up any leftover config file
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
    try { fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { fs.unlinkSync(CONFIG_PATH); } catch { /* ignore */ }
  });

  describe('loadConfig', () => {
    it('returns defaults when no config file exists', () => {
      const config = loadConfig();
      expect(config.theme).toBe('system');
      expect(config.font).toBe('default');
      expect(config.model).toBeNull();
      expect(config.workspace).toBeNull();
      expect(config.personas).toEqual([]);
      expect(config.personasSeeded).toBe(false);
      expect(config.webRemoteEnabled).toBe(false);
      expect(config.webRemotePort).toBe(DEFAULT_WEB_REMOTE_PORT);
      expect(config.webRemoteToken.length).toBeGreaterThan(20);
    });

    it('persists the selected font across reloads', () => {
      loadConfig();
      setConfigValue('font', 'georgia');
      expect(loadConfig().font).toBe('georgia');
    });

    it.each([undefined, null, 'missing-font', 42])('defaults old or invalid font settings (%s)', font => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ theme: 'dark', font }));
      expect(loadConfig().font).toBe('default');
    });

    it('includes new cliTools field with default empty array', () => {
      const config = loadConfig();
      expect(config.cliTools).toEqual([]);
    });

    it('includes new mcpServers field with default empty array', () => {
      const config = loadConfig();
      expect(config.mcpServers).toEqual([]);
    });

    it('defaults web remote bind selections to loopback', () => {
      const config = loadConfig();
      expect(config.webRemoteBindSelections).toEqual([{ kind: 'address', address: '127.0.0.1' }]);
    });

    it('migrates legacy bind addresses into durable selections', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        webRemoteBindAddresses: ['127.0.0.1', '203.0.113.9'],
      }));
      const config = loadConfig();
      expect(config.webRemoteBindSelections).toEqual([
        { kind: 'address', address: '127.0.0.1' },
        { kind: 'address', address: '203.0.113.9' },
      ]);
      expect((config as Record<string, unknown>).webRemoteBindAddresses).toBeUndefined();
    });

    it('preserves saved selections for interfaces that are not currently up', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        webRemoteBindSelections: [{ kind: 'interface', interfaceName: 'utun99', family: 'IPv4' }],
      }));
      const config = loadConfig();
      expect(config.webRemoteBindSelections).toEqual([
        { kind: 'interface', interfaceName: 'utun99', family: 'IPv4' },
      ]);
    });

    it('loads existing config and merges with defaults', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        theme: 'dark',
        model: 'gpt-4',
      }));
      const config = loadConfig();
      expect(config.theme).toBe('dark');
      expect(config.model).toBe('gpt-4');
      // Defaults for missing fields
      expect(config.cliTools).toEqual([]);
      expect(config.mcpServers).toEqual([]);
      expect(config.personas).toEqual([]);
    });

    it('defaults cliSource to bundled for a fresh install', () => {
      const config = loadConfig();
      expect(config.cliSource).toBe('bundled');
      expect(config.cliServerUrl).toBeNull();
      expect(config.cliServerToken).toBeNull();
    });

    it("migrates an existing explicit cliPath to cliSource='path'", () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ cliPath: '/usr/local/bin/copilot' }));
      const config = loadConfig();
      expect(config.cliSource).toBe('path');
      expect(config.cliPath).toBe('/usr/local/bin/copilot');
    });

    it("migrates an existing auto-detect (null cliPath) install to cliSource='bundled'", () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ cliPath: null, theme: 'dark' }));
      const config = loadConfig();
      expect(config.cliSource).toBe('bundled');
    });

    it('preserves an explicitly configured cliSource', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ cliSource: 'server', cliServerUrl: 'localhost:9001' }));
      const config = loadConfig();
      expect(config.cliSource).toBe('server');
      expect(config.cliServerUrl).toBe('localhost:9001');
    });

    it('persists the experimental in-process choice without changing custom connection settings', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        cliSource: 'path', cliPath: '/custom/copilot', cliServerUrl: 'localhost:9001',
      }));
      loadConfig();
      setConfigValue('cliSource', 'inprocess');
      const config = loadConfig();
      expect(config.cliSource).toBe('inprocess');
      expect(config.cliPath).toBe('/custom/copilot');
      expect(config.cliServerUrl).toBe('localhost:9001');
    });

    it('handles malformed JSON gracefully', () => {
      fs.writeFileSync(CONFIG_PATH, 'not json');
      const config = loadConfig();
      expect(config.theme).toBe('system');      expect(config.cliTools).toEqual([]);
    });
  });

  describe('getConfigValue / setConfigValue', () => {
    it('gets and sets values', () => {
      loadConfig();
      setConfigValue('theme', 'dark');
      expect(getConfigValue('theme')).toBe('dark');
    });

    it('persists cliTools to disk', () => {
      loadConfig();
      const tools = [{ name: 'gh', description: 'GitHub CLI' }];
      setConfigValue('cliTools', tools);

      // Re-read from disk
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.cliTools).toEqual(tools);
    });

    it('persists mcpServers to disk', () => {
      loadConfig();
      const servers = [{ name: 'test', type: 'stdio' as const, command: 'echo', args: [], tools: ['*'] }];
      setConfigValue('mcpServers', servers);

      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.mcpServers).toEqual(servers);
    });
  });

  describe('getConfig', () => {
    it('returns the full config object', () => {
      loadConfig();
      const config = getConfig();
      expect(config).toHaveProperty('theme');
      expect(config).toHaveProperty('cliTools');
      expect(config).toHaveProperty('mcpServers');
      expect(config).toHaveProperty('personas');
    });
  });

  describe('getSessionId / setSessionId / removeSession', () => {
    it('stores and retrieves a session ID', () => {
      loadConfig();
      setSessionId('space-1', 'session-abc');
      expect(getSessionId('space-1')).toBe('session-abc');
    });

    it('returns null for an unknown space ID', () => {
      loadConfig();
      expect(getSessionId('nonexistent')).toBeNull();
    });

    it('removes a stored session ID', () => {
      loadConfig();
      setSessionId('space-2', 'session-xyz');
      expect(getSessionId('space-2')).toBe('session-xyz');
      removeSession('space-2');
      expect(getSessionId('space-2')).toBeNull();
    });

    it('persists session IDs to disk', () => {
      loadConfig();
      setSessionId('space-3', 'session-disk');

      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.sessions['space-3']).toBe('session-disk');
    });

    it('removes session ID from disk after removeSession', () => {
      loadConfig();
      setSessionId('space-4', 'session-temp');
      removeSession('space-4');

      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.sessions['space-4']).toBeUndefined();
    });
  });

  describe('saveConfig failure handling', () => {
    it('handles write errors gracefully', () => {
      loadConfig();
      // Remove the directory so writeFileSync fails with ENOENT
      fs.rmSync(path.dirname(CONFIG_PATH), { recursive: true });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => saveConfig()).not.toThrow();
      expect(consoleSpy).toHaveBeenCalledWith(
        '[config] Failed to save config:',
        expect.any(Error),
      );

      consoleSpy.mockRestore();
      // Recreate directory for afterEach cleanup
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    });
  });

  describe('config shape preservation', () => {
    it('setting one key does not remove other keys from persisted file', () => {
      loadConfig();
      setConfigValue('theme', 'dark');
      setConfigValue('model', 'gpt-4');

      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.theme).toBe('dark');
      expect(raw.model).toBe('gpt-4');
    });
  });

  describe('edge cases', () => {
    it('loading config with extra unknown fields does not crash', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        theme: 'dark',
        unknownField: 'hello',
        anotherFutureField: 42,
      }));
      const config = loadConfig();
      expect(config.theme).toBe('dark');
      expect((config as unknown as Record<string, unknown>)['unknownField']).toBe('hello');
    });

    it('setConfigValue for sessions persists the full sessions map', () => {
      loadConfig();
      const sessions: Record<string, string> = {
        'space-a': 'sess-1',
        'space-b': 'sess-2',
      };
      setConfigValue('sessions', sessions);

      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.sessions).toEqual(sessions);
    });
  });

  describe('hotkeys', () => {
    it('includes a switchProfile default accelerator', () => {
      expect(DEFAULT_HOTKEYS.switchProfile).toBe('CommandOrControl+Shift+P');
    });
  });

  describe('quick start onboarding flags', () => {
    beforeEach(() => {
      fs.writeFileSync(CONFIG_PATH, '{}');
    });

    it('treats a fresh install as not having seen the quick start', () => {
      const config = loadConfig();
      expect(config.quickStartCompleted).toBe(false);
      expect(config.onboardingTipsSeen).toBe(false);
    });

    it('persists completion so the tour only runs once', () => {
      loadConfig();
      setConfigValue('quickStartCompleted', true);

      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.quickStartCompleted).toBe(true);
      expect(getConfigValue('quickStartCompleted')).toBe(true);
    });
  });

  describe('workspace profiles', () => {
    beforeEach(() => {
      // loadConfig() only resets in-memory state when a file exists; write an
      // empty one so each profile test starts from clean defaults.
      fs.writeFileSync(CONFIG_PATH, '{}');
    });

    it('defaults to an empty profile list with no active profile', () => {
      const config = loadConfig();
      expect(config.profiles).toEqual([]);
      expect(config.activeProfileId).toBeNull();
    });

    it('migrates a legacy single workspace into a seeded profile', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({ workspace: '/legacy/repo' }));
      const config = loadConfig();
      expect(config.profiles).toHaveLength(1);
      expect(config.profiles[0].path).toBe('/legacy/repo');
      expect(config.profiles[0].name).toBeNull();
      expect(config.profiles[0].tint).toBeNull();
      expect(config.activeProfileId).toBe(config.profiles[0].id);
      // Active path is mirrored back into `workspace`.
      expect(config.workspace).toBe('/legacy/repo');
    });

    it('does not re-seed when profiles already exist', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        workspace: '/work/repo',
        profiles: [
          { id: 'a', path: '/work/repo', name: 'Work', tint: '#7c66dc' },
          { id: 'b', path: '/personal/repo', name: null, tint: null },
        ],
        activeProfileId: 'b',
      }));
      const config = loadConfig();
      expect(config.profiles).toHaveLength(2);
      expect(config.activeProfileId).toBe('b');
      // workspace is reconciled to the active profile's path.
      expect(config.workspace).toBe('/personal/repo');
    });

    it('reconciles an invalid activeProfileId to the first profile', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        profiles: [{ id: 'a', path: '/repo-a', name: null, tint: null }],
        activeProfileId: 'gone',
      }));
      const config = loadConfig();
      expect(config.activeProfileId).toBe('a');
      expect(config.workspace).toBe('/repo-a');
    });

    it('preserves an explicitly cleared workspace when saved profiles exist', () => {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify({
        workspace: null,
        profiles: [{ id: 'a', path: '/repo-a', name: null, tint: null }],
        activeProfileId: null,
      }));
      const config = loadConfig();
      expect(config.activeProfileId).toBeNull();
      expect(config.workspace).toBeNull();
    });

    it('upserts a profile for a path and dedupes by resolved path', () => {
      loadConfig();
      const first = upsertProfileForPath('/repo/one');
      const again = upsertProfileForPath('/repo/one');
      expect(again.id).toBe(first.id);
      expect(getProfiles()).toHaveLength(1);

      const second = upsertProfileForPath('/repo/two');
      expect(second.id).not.toBe(first.id);
      expect(getProfiles()).toHaveLength(2);
    });

    it('updates a profile name override (blank clears it) and tint', () => {
      loadConfig();
      const p = upsertProfileForPath('/repo/x');
      updateProfile(p.id, { name: 'Custom', tint: '#abcdef' });
      expect(getProfileById(p.id)?.name).toBe('Custom');
      expect(getProfileById(p.id)?.tint).toBe('#abcdef');

      updateProfile(p.id, { name: '   ' });
      expect(getProfileById(p.id)?.name).toBeNull();
    });

    it('activates a profile and mirrors its path into workspace', () => {
      loadConfig();
      const p = upsertProfileForPath('/repo/active');
      setActiveProfile(p.id);
      expect(getActiveProfileId()).toBe(p.id);
      expect(getActiveProfile()?.id).toBe(p.id);
      expect(getConfigValue('workspace')).toBe('/repo/active');
    });

    it('clears the active profile when passed null', () => {
      loadConfig();
      const p = upsertProfileForPath('/repo/active');
      setActiveProfile(p.id);
      setActiveProfile(null);
      expect(getActiveProfileId()).toBeNull();
      expect(getActiveProfile()).toBeNull();
      expect(getConfigValue('workspace')).toBeNull();
    });

    it('cycles to the next profile, wrapping around', () => {
      loadConfig();
      const a = upsertProfileForPath('/repo/a');
      const b = upsertProfileForPath('/repo/b');
      setActiveProfile(a.id);
      expect(getNextProfile()?.id).toBe(b.id);
      setActiveProfile(b.id);
      expect(getNextProfile()?.id).toBe(a.id);
    });

    it('has no next profile when fewer than two exist', () => {
      loadConfig();
      expect(getNextProfile()).toBeNull();
      const a = upsertProfileForPath('/repo/solo');
      setActiveProfile(a.id);
      expect(getNextProfile()).toBeNull();
    });

    it('removing the active profile clears the active id', () => {
      loadConfig();
      const a = upsertProfileForPath('/repo/a');
      setActiveProfile(a.id);
      removeProfileById(a.id);
      expect(getProfiles()).toHaveLength(0);
      expect(getActiveProfileId()).toBeNull();
    });

    it('generates unique profile ids', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateProfileId()));
      expect(ids.size).toBe(50);
    });

    it('persists profiles + activeProfileId to disk', () => {
      loadConfig();
      const p = upsertProfileForPath('/repo/persist');
      setActiveProfile(p.id);
      updateProfile(p.id, { tint: '#123456' });

      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.profiles).toHaveLength(1);
      expect(raw.profiles[0].tint).toBe('#123456');
      expect(raw.activeProfileId).toBe(p.id);
    });
  });

  describe('export destinations', () => {
    beforeEach(() => {
      loadConfig();
    });

    it('defaults to an empty list', () => {
      expect(getExportDestinations()).toEqual([]);
    });

    it('validates and normalizes raw destinations', () => {
      const result = validateExportDestinations([
        { id: 'a', label: '  Work  ', path: '/sync/work', defaultFormat: 'docx' },
        { label: 'No id', path: '/sync/x' },          // id generated, format defaults to pdf
        { label: '', path: '/sync/y' },               // dropped: empty label
        { label: 'No path', path: '   ' },            // dropped: empty path
        { label: 'Bad format', path: '/p', defaultFormat: 'rtf' }, // format clamped to pdf
        'not-an-object',                               // dropped
      ]);
      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({ id: 'a', label: 'Work', path: '/sync/work', defaultFormat: 'docx' });
      expect(result[1].label).toBe('No id');
      expect(result[1].defaultFormat).toBe('pdf');
      expect(typeof result[1].id).toBe('string');
      expect(result[1].id.length).toBeGreaterThan(0);
      expect(result[2].defaultFormat).toBe('pdf');
    });

    it('returns an empty list for non-array input', () => {
      expect(validateExportDestinations(null)).toEqual([]);
      expect(validateExportDestinations({})).toEqual([]);
    });

    it('caps the list at 32 entries', () => {
      const many = Array.from({ length: 40 }, (_, i) => ({ label: `d${i}`, path: `/p/${i}` }));
      expect(validateExportDestinations(many)).toHaveLength(32);
    });

    it('persists destinations and looks them up by id', () => {
      const saved = setExportDestinations([{ id: 'work', label: 'Work', path: '/sync/work', defaultFormat: 'pdf' }]);
      expect(saved).toHaveLength(1);
      expect(getExportDestinationById('work')?.path).toBe('/sync/work');
      expect(getExportDestinationById('missing')).toBeNull();

      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      expect(raw.exportDestinations).toHaveLength(1);
      expect(raw.exportDestinations[0].label).toBe('Work');
    });

    it('generates unique destination ids', () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateExportDestinationId()));
      expect(ids.size).toBe(50);
    });
  });
});
