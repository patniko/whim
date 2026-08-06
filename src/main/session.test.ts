import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExistsSync, mockStatSync, mockMkdirSync, mockExecSync, mockReaddirSync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(p: unknown) => boolean>(),
  mockStatSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockExecSync: vi.fn(),
  mockReaddirSync: vi.fn<(p: unknown) => string[]>(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/space-test', getAppPath: () => '/mock/app' },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: mockExistsSync, statSync: mockStatSync, mkdirSync: mockMkdirSync, readdirSync: mockReaddirSync };
});

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  // Route async exec() through the same mock as execSync so tests only have to
  // describe command behaviour once.
  const exec = (cmd: string, _opts: unknown, cb: (e: Error | null, stdout: string) => void): void => {
    try {
      cb(null, String(mockExecSync(cmd)));
    } catch (err) {
      cb(err as Error, '');
    }
  };
  return { ...actual, execSync: mockExecSync, exec };
});

vi.mock('./config', () => ({
  getConfigValue: vi.fn(),
  getSessionId: vi.fn(),
  setSessionId: vi.fn(),
}));

vi.mock('./database', () => ({
  getSpace: vi.fn(),
  assignSpaceFolder: vi.fn(),
  setSpaceSessionId: vi.fn(),
}));

vi.mock('./workspace', () => ({
  createSpaceFolder: vi.fn(),
}));

import { resolveCopilotCliPath, invalidateCliPath, checkCopilotCli, launchSession, parseCliVersion, compareVersions, getCopilotCliVersion, checkCliCompatibility, resolveCmdToJs, isCliMxcCapable, invalidateMxcCapability, findLatestSelfUpdatedCli, findSelfUpdatedClis, discoverCopilotClis, probeCliVersion, resolveAutoDetectedCliPath, MIN_CLI_VERSION } from './session';
import { getConfigValue } from './config';

const mockGetConfigValue = vi.mocked(getConfigValue);

describe('session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCliPath();
  });

  // ── resolveCopilotCliPath ─────────────────────────────

  describe('resolveCopilotCliPath', () => {
    it('returns configured cliPath if it exists on disk', () => {
      mockGetConfigValue.mockReturnValue('/custom/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/custom/bin/copilot');

      const result = resolveCopilotCliPath();
      expect(result).toBe('/custom/bin/copilot');
    });

    it('falls back to auto-detect if configured cliPath does not exist', () => {
      mockGetConfigValue.mockReturnValue('/missing/copilot');
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = resolveCopilotCliPath();
      expect(result).toBeNull();
    });

    it('auto-detects via which/where when no config override is set', () => {
      mockGetConfigValue.mockReturnValue(null);
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/usr/local/bin/copilot-found';
      });
      mockExecSync.mockReturnValue(
        Buffer.from('/usr/local/bin/copilot-found\n')
      );

      const result = resolveCopilotCliPath();
      expect(result).toBe('/usr/local/bin/copilot-found');
    });

    it('caches result after first call', () => {
      mockGetConfigValue.mockReturnValue('/cached/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/cached/copilot');

      const first = resolveCopilotCliPath();
      expect(first).toBe('/cached/copilot');

      // Change mock — should still return cached value
      mockGetConfigValue.mockReturnValue('/other/copilot');

      const second = resolveCopilotCliPath();
      expect(second).toBe('/cached/copilot');
    });

    it('re-resolves after invalidateCliPath()', () => {
      mockGetConfigValue.mockReturnValue('/first/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/first/copilot' || p === '/second/copilot');

      expect(resolveCopilotCliPath()).toBe('/first/copilot');

      invalidateCliPath();
      mockGetConfigValue.mockReturnValue('/second/copilot');

      expect(resolveCopilotCliPath()).toBe('/second/copilot');
    });

    it('skips node_modules shims from which output', () => {
      mockGetConfigValue.mockReturnValue(null);
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === '/home/user/.npm-global/bin/copilot';
      });
      mockExecSync.mockReturnValue(
        Buffer.from('/project/node_modules/.bin/copilot\n/home/user/.npm-global/bin/copilot\n')
      );

      const result = resolveCopilotCliPath();
      expect(result).toBe('/home/user/.npm-global/bin/copilot');
    });
  });


  // ── findLatestSelfUpdatedCli ──────────────────────────

  describe('findLatestSelfUpdatedCli', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      process.env = { ...originalEnv };
    });

    it('returns null when no bundles are present on macOS/Linux', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      mockExistsSync.mockReturnValue(false);
      expect(findLatestSelfUpdatedCli()).toBeNull();
    });

    it('scans macOS self-update caches and returns the newest bundle', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.HOME = '/Users/test';
      delete process.env.COPILOT_CACHE_HOME;
      delete process.env.COPILOT_HOME;
      const base = `/Users/test/.copilot/pkg/darwin-${process.arch}`;
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === base) return true;
        if (s.endsWith('index.js') || s.endsWith('app.js')) return true;
        return false;
      });
      mockReaddirSync.mockImplementation((p: unknown) =>
        String(p) === base ? ['1.0.58', '1.0.62', '1.0.60'] : []);
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      expect(findLatestSelfUpdatedCli()).toBe(`${base}/1.0.62/index.js`);
    });

    it('returns null when LOCALAPPDATA is not set', () => {
      delete process.env.LOCALAPPDATA;
      expect(findLatestSelfUpdatedCli()).toBeNull();
    });

    it('returns null when universal directory does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(findLatestSelfUpdatedCli()).toBeNull();
    });

    it('returns the latest version index.js when multiple versions exist', () => {
      const base = 'C:\\Users\\test\\AppData\\Local\\copilot\\pkg\\universal';
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === base) return true;
        // All version dirs have index.js
        if (s.endsWith('index.js') || s.endsWith('app.js')) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(['1.0.44', '1.0.57-3', '1.0.44-2']);
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      const result = findLatestSelfUpdatedCli();
      expect(result).toBe(`${base}\\1.0.57-3\\index.js`);
    });

    it('picks higher pre-release tag when base versions match', () => {
      const base = 'C:\\Users\\test\\AppData\\Local\\copilot\\pkg\\universal';
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === base) return true;
        if (s.endsWith('index.js') || s.endsWith('app.js')) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(['1.0.44', '1.0.44-3', '1.0.44-2']);
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      const result = findLatestSelfUpdatedCli();
      expect(result).toBe(`${base}\\1.0.44-3\\index.js`);
    });

    it('skips entries without index.js', () => {
      const base = 'C:\\Users\\test\\AppData\\Local\\copilot\\pkg\\universal';
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === base) return true;
        // Only 1.0.44 has a complete bundle (index.js + app.js)
        if (s === `${base}\\1.0.44\\index.js` || s === `${base}\\1.0.44\\app.js`) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(['1.0.57-3', '1.0.44']);
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      const result = findLatestSelfUpdatedCli();
      expect(result).toBe(`${base}\\1.0.44\\index.js`);
    });

    it('returns null when no version directories contain index.js', () => {
      const base = 'C:\\Users\\test\\AppData\\Local\\copilot\\pkg\\universal';
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === base) return true;
        return false;
      });
      mockReaddirSync.mockReturnValue(['1.0.44']);
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      expect(findLatestSelfUpdatedCli()).toBeNull();
    });
  });

  // ── findSelfUpdatedClis / discoverCopilotClis ─────────

  describe('findSelfUpdatedClis', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.HOME = '/Users/test';
      delete process.env.COPILOT_CACHE_HOME;
      delete process.env.COPILOT_HOME;
      delete process.env.LOCALAPPDATA;
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      process.env = { ...originalEnv };
    });

    it('returns every complete bundle, newest first', () => {
      const base = `/Users/test/.copilot/pkg/darwin-${process.arch}`;
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === base) return true;
        return s.endsWith('index.js') || s.endsWith('app.js');
      });
      mockReaddirSync.mockImplementation((p: unknown) =>
        String(p) === base ? ['1.0.58', '1.0.75', '1.0.60'] : []);
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      expect(findSelfUpdatedClis()).toEqual([
        { path: `${base}/1.0.75/index.js`, version: '1.0.75' },
        { path: `${base}/1.0.60/index.js`, version: '1.0.60' },
        { path: `${base}/1.0.58/index.js`, version: '1.0.58' },
      ]);
    });

    it('skips half-extracted bundles missing app.js', () => {
      const base = `/Users/test/.copilot/pkg/darwin-${process.arch}`;
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === base) return true;
        if (s === `${base}/1.0.75/index.js`) return true;
        return s === `${base}/1.0.60/index.js` || s === `${base}/1.0.60/app.js`;
      });
      mockReaddirSync.mockImplementation((p: unknown) =>
        String(p) === base ? ['1.0.75', '1.0.60'] : []);
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      expect(findSelfUpdatedClis()).toEqual([
        { path: `${base}/1.0.60/index.js`, version: '1.0.60' },
      ]);
    });

    it('returns an empty list when no caches exist', () => {
      mockExistsSync.mockReturnValue(false);
      expect(findSelfUpdatedClis()).toEqual([]);
    });
  });

  describe('discoverCopilotClis', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.HOME = '/Users/test';
      delete process.env.COPILOT_CACHE_HOME;
      delete process.env.COPILOT_HOME;
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      process.env = { ...originalEnv };
    });

    it('lists every install with its version, origin and compatibility', async () => {
      const cacheBase = `/Users/test/.copilot/pkg/darwin-${process.arch}`;
      const selfUpdated = `${cacheBase}/1.0.75/index.js`;
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === cacheBase) return true;
        if (s.startsWith(cacheBase)) return s.endsWith('index.js') || s.endsWith('app.js');
        return s === '/opt/homebrew/bin/copilot';
      });
      mockReaddirSync.mockImplementation((p: unknown) =>
        String(p) === cacheBase ? ['1.0.75'] : []);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockExecSync.mockImplementation((cmd: unknown) => {
        const s = String(cmd);
        if (s.includes('which -a') || s.includes('command -v')) throw new Error('not found');
        if (s.includes(selfUpdated)) return Buffer.from('GitHub Copilot CLI 1.0.75');
        if (s.includes('/opt/homebrew/bin/copilot')) return Buffer.from('GitHub Copilot CLI 1.0.20');
        throw new Error('unexpected');
      });

      const result = await discoverCopilotClis();
      const paths = result.map(r => r.path);
      expect(paths).toContain(selfUpdated);
      expect(paths).toContain('/opt/homebrew/bin/copilot');

      const cache = result.find(r => r.path === selfUpdated)!;
      expect(cache).toMatchObject({ version: '1.0.75', origin: 'Self-updated', source: 'path', compatible: true });

      const brew = result.find(r => r.path === '/opt/homebrew/bin/copilot')!;
      expect(brew).toMatchObject({ version: '1.0.20', origin: 'Homebrew', compatible: false });
    });

    it('collapses duplicate builds of the same self-updated version', async () => {
      const cacheBase = `/Users/test/.copilot/pkg/darwin-${process.arch}`;
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === cacheBase) return true;
        return s.startsWith(cacheBase) && (s.endsWith('index.js') || s.endsWith('app.js'));
      });
      mockReaddirSync.mockImplementation((p: unknown) =>
        String(p) === cacheBase ? ['1.0.75', '1.0.75-2', '1.0.75-1'] : []);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      const cacheEntries = (await discoverCopilotClis()).filter(r => r.origin === 'Self-updated');
      expect(cacheEntries).toEqual([
        expect.objectContaining({ path: `${cacheBase}/1.0.75-2/index.js`, version: '1.0.75' }),
      ]);
    });

    it('uses the cache directory name instead of spawning a version probe', async () => {
      const cacheBase = `/Users/test/.copilot/pkg/darwin-${process.arch}`;
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === cacheBase) return true;
        return s.startsWith(cacheBase) && (s.endsWith('index.js') || s.endsWith('app.js'));
      });
      mockReaddirSync.mockImplementation((p: unknown) =>
        String(p) === cacheBase ? ['1.0.75'] : []);
      mockStatSync.mockReturnValue({ isDirectory: () => true });
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      const entry = (await discoverCopilotClis()).find(r => r.origin === 'Self-updated')!;
      expect(entry.version).toBe('1.0.75');
      // Only PATH/login-shell lookups may spawn — never a `--version` probe of
      // a cache bundle whose version is already in its directory name.
      const probes = mockExecSync.mock.calls.filter(c => String(c[0]).includes('--version'));
      expect(probes).toHaveLength(0);
    });

    it('deduplicates the same install found through multiple paths', async () => {
      mockExistsSync.mockImplementation((p: unknown) => String(p) === '/usr/local/bin/copilot');
      mockReaddirSync.mockReturnValue([]);
      mockExecSync.mockImplementation((cmd: unknown) => {
        const s = String(cmd);
        if (s.includes('which -a')) return Buffer.from('/usr/local/bin/copilot\n');
        if (s.includes('command -v')) return Buffer.from('/usr/local/bin/copilot');
        return Buffer.from('GitHub Copilot CLI 1.0.80');
      });

      const result = await discoverCopilotClis();
      expect(result.filter(r => r.path === '/usr/local/bin/copilot')).toHaveLength(1);
    });

    it('ignores node_modules shims found on PATH', async () => {
      const shim = '/proj/node_modules/.bin/copilot';
      mockExistsSync.mockImplementation((p: unknown) => String(p) === shim);
      mockReaddirSync.mockReturnValue([]);
      mockExecSync.mockImplementation((cmd: unknown) => {
        const s = String(cmd);
        if (s.includes('which -a')) return Buffer.from(`${shim}\n`);
        throw new Error('not found');
      });

      expect((await discoverCopilotClis()).map(r => r.path)).not.toContain(shim);
    });
  });

  // ── resolveCmdToJs ────────────────────────────────────

  describe('resolveCmdToJs', () => {
    const originalPlatform = process.platform;

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('resolves .cmd to @github/copilot/index.js in the same npm prefix', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === 'C:\\ProgramData\\npm\\node_modules\\@github\\copilot\\index.js';
      });

      const result = resolveCmdToJs('C:\\ProgramData\\npm\\copilot.cmd');
      expect(result).toBe('C:\\ProgramData\\npm\\node_modules\\@github\\copilot\\index.js');
    });

    it('returns original .cmd if index.js does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = resolveCmdToJs('C:\\ProgramData\\npm\\copilot.cmd');
      expect(result).toBe('C:\\ProgramData\\npm\\copilot.cmd');
    });

    it('returns original path for non-.cmd non-shim files (e.g. .exe)', () => {
      const result = resolveCmdToJs('C:\\ProgramData\\npm\\copilot.exe');
      expect(result).toBe('C:\\ProgramData\\npm\\copilot.exe');
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it('resolves extensionless npm shim to index.js when .cmd sibling exists', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === 'C:\\Users\\test\\AppData\\Roaming\\npm\\copilot.cmd'
            || p === 'C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\index.js';
      });

      const result = resolveCmdToJs('C:\\Users\\test\\AppData\\Roaming\\npm\\copilot');
      expect(result).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules\\@github\\copilot\\index.js');
    });

    it('returns original extensionless path when no .cmd sibling exists', () => {
      mockExistsSync.mockReturnValue(false);
      const result = resolveCmdToJs('C:\\some\\path\\copilot');
      expect(result).toBe('C:\\some\\path\\copilot');
    });

    it('returns original path on non-win32 platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      const result = resolveCmdToJs('C:\\ProgramData\\npm\\copilot.cmd');
      expect(result).toBe('C:\\ProgramData\\npm\\copilot.cmd');
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it('resolves .cmd in node_modules/.bin/ to sibling @github/copilot/index.js', () => {
      mockExistsSync.mockImplementation((p: unknown) => {
        return p === 'C:\\projects\\my-app\\node_modules\\@github\\copilot\\index.js';
      });

      const result = resolveCmdToJs('C:\\projects\\my-app\\node_modules\\.bin\\copilot.cmd');
      expect(result).toBe('C:\\projects\\my-app\\node_modules\\@github\\copilot\\index.js');
    });
  });

  // ── checkCopilotCli (deprecated wrapper) ──────────────

  describe('checkCopilotCli', () => {
    it('returns same value as resolveCopilotCliPath', async () => {
      mockGetConfigValue.mockReturnValue('/cli/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/cli/copilot');

      const sync = resolveCopilotCliPath();
      invalidateCliPath();
      const asyncResult = await checkCopilotCli();
      expect(asyncResult).toBe(sync);
    });
  });

  // ── launchSession validation ──────────────────────────

  describe('launchSession', () => {
    it('returns error when workspace directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      const result = await launchSession('space-1', '/nonexistent/workspace');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Workspace directory does not exist');
    });

    it('returns error when copilot CLI is not found', async () => {
      mockGetConfigValue.mockReturnValue(null);

      // Workspace exists and is a directory
      mockExistsSync.mockImplementation((p: unknown) => {
        if (p === '/valid/workspace') return true;
        return false;
      });
      mockStatSync.mockImplementation((p: unknown) => {
        if (p === '/valid/workspace') {
          return { isDirectory: () => true } as import('fs').Stats;
        }
        throw new Error('ENOENT');
      });

      mockExecSync.mockImplementation(() => {
        throw new Error('not found');
      });

      const result = await launchSession('space-2', '/valid/workspace');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Copilot CLI not found');
    });
  });

  // ── parseCliVersion ──────────────────────────────────

  describe('parseCliVersion', () => {
    it('parses standard version output', () => {
      expect(parseCliVersion('GitHub Copilot CLI 1.0.36.')).toBe('1.0.36');
    });

    it('parses version with extra text', () => {
      expect(parseCliVersion('GitHub Copilot CLI 1.0.36.\nRun \'copilot update\' to check for updates.')).toBe('1.0.36');
    });

    it('parses just a version number', () => {
      expect(parseCliVersion('2.1.0')).toBe('2.1.0');
    });

    it('returns null for unparseable output', () => {
      expect(parseCliVersion('no version here')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseCliVersion('')).toBeNull();
    });
  });

  // ── compareVersions ──────────────────────────────────

  describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
      expect(compareVersions('1.0.36', '1.0.36')).toBe(0);
    });

    it('returns positive when a > b (patch)', () => {
      expect(compareVersions('1.0.37', '1.0.36')).toBeGreaterThan(0);
    });

    it('returns negative when a < b (patch)', () => {
      expect(compareVersions('1.0.35', '1.0.36')).toBeLessThan(0);
    });

    it('returns positive when a > b (minor)', () => {
      expect(compareVersions('1.1.0', '1.0.36')).toBeGreaterThan(0);
    });

    it('returns positive when a > b (major)', () => {
      expect(compareVersions('2.0.0', '1.0.36')).toBeGreaterThan(0);
    });

    it('returns negative when a < b (major)', () => {
      expect(compareVersions('0.9.99', '1.0.0')).toBeLessThan(0);
    });

    it('handles different length versions', () => {
      expect(compareVersions('1.0', '1.0.0')).toBe(0);
    });
  });

  // ── getCopilotCliVersion ─────────────────────────────

  describe('getCopilotCliVersion', () => {
    it('returns parsed version when CLI responds', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.36.\n'));

      const version = getCopilotCliVersion();
      expect(version).toBe('1.0.36');
    });

    it('uses process.execPath for .js CLI paths', () => {
      mockGetConfigValue.mockReturnValue('/project/node_modules/@github/copilot/dist/index.js');
      mockExistsSync.mockImplementation((p: unknown) => p === '/project/node_modules/@github/copilot/dist/index.js');
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.36.\n'));

      getCopilotCliVersion();
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining(process.execPath),
        expect.any(Object),
      );
    });

    it('returns null when CLI is not found', () => {
      mockGetConfigValue.mockReturnValue(null);
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      const version = getCopilotCliVersion();
      expect(version).toBeNull();
    });

    it('returns null when version output is unparseable', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('some unexpected output'));

      const version = getCopilotCliVersion();
      expect(version).toBeNull();
    });

    it('caches result after first call', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.36.\n'));

      const first = getCopilotCliVersion();
      expect(first).toBe('1.0.36');

      // Change mock — should still return cached value
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 2.0.0.\n'));
      const second = getCopilotCliVersion();
      expect(second).toBe('1.0.36');
    });

    it('re-resolves after invalidateCliPath()', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.36.\n'));

      expect(getCopilotCliVersion()).toBe('1.0.36');

      invalidateCliPath();
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.40.\n'));
      expect(getCopilotCliVersion()).toBe('1.0.40');
    });
  });

  // ── probeCliVersion ──────────────────────────────────

  describe('probeCliVersion', () => {
    it('parses the version from --version output', () => {
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.62.\n'));
      expect(probeCliVersion('/opt/homebrew/bin/copilot')).toBe('1.0.62');
    });

    it('runs .js entries via the current Node/Electron binary', () => {
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.56-2.\n'));
      expect(probeCliVersion('/bundled/index.js')).toBe('1.0.56');
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining(process.execPath),
        expect.any(Object),
      );
    });

    it('returns null when the probe fails', () => {
      mockExecSync.mockImplementation(() => { throw new Error('spawn failed'); });
      expect(probeCliVersion('/missing/copilot')).toBeNull();
    });

    it('caches per path so a repeat probe does not respawn the CLI', () => {
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.62.\n'));
      expect(probeCliVersion('/cached/copilot')).toBe('1.0.62');
      expect(probeCliVersion('/cached/copilot')).toBe('1.0.62');
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });

    it('re-probes after invalidateCliPath()', () => {
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.62.\n'));
      expect(probeCliVersion('/invalidated/copilot')).toBe('1.0.62');

      invalidateCliPath();
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.71.\n'));
      expect(probeCliVersion('/invalidated/copilot')).toBe('1.0.71');
    });
  });

  // ── resolveAutoDetectedCliPath ───────────────────────

  describe('resolveAutoDetectedCliPath', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      process.env = { ...originalEnv };
    });

    it('prefers the newest self-updated CLI over PATH lookups', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      process.env.HOME = '/Users/test';
      delete process.env.COPILOT_CACHE_HOME;
      delete process.env.COPILOT_HOME;
      const base = `/Users/test/.copilot/pkg/darwin-${process.arch}`;
      mockExistsSync.mockImplementation((p: unknown) => {
        const s = String(p);
        if (s === base) return true;
        return s.endsWith('index.js') || s.endsWith('app.js');
      });
      mockReaddirSync.mockImplementation((p: unknown) => (String(p) === base ? ['1.0.60', '1.0.62'] : []));
      mockStatSync.mockReturnValue({ isDirectory: () => true });

      expect(resolveAutoDetectedCliPath()).toBe(`${base}/1.0.62/index.js`);
      // Self-update is filesystem-only — no `which` spawn needed.
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  // ── checkCliCompatibility ────────────────────────────

  describe('checkCliCompatibility', () => {
    it('returns compatible for version >= minimum', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.78.\n'));

      const info = checkCliCompatibility();
      expect(info.path).toBe('/usr/bin/copilot');
      expect(info.version).toBe('1.0.78');
      expect(info.compatible).toBe(true);
      expect(info.minVersion).toBe(MIN_CLI_VERSION);
    });

    it('returns compatible for version > minimum', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 2.0.0.\n'));

      const info = checkCliCompatibility();
      expect(info.compatible).toBe(true);
    });

    it('returns incompatible for version < minimum', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 1.0.77.\n'));

      const info = checkCliCompatibility();
      expect(info.path).toBe('/usr/bin/copilot');
      expect(info.version).toBe('1.0.77');
      expect(info.compatible).toBe(false);
    });

    it('returns incompatible when CLI not found', () => {
      mockGetConfigValue.mockReturnValue(null);
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      const info = checkCliCompatibility();
      expect(info.path).toBeNull();
      expect(info.version).toBeNull();
      expect(info.compatible).toBe(false);
    });

    it('returns incompatible when version cannot be parsed', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('unexpected output'));

      const info = checkCliCompatibility();
      expect(info.path).toBe('/usr/bin/copilot');
      expect(info.version).toBeNull();
      expect(info.compatible).toBe(false);
    });

    it('returns compatible for dev version 0.0.1', () => {
      mockGetConfigValue.mockReturnValue('/usr/bin/copilot');
      mockExistsSync.mockImplementation((p: unknown) => p === '/usr/bin/copilot');
      mockExecSync.mockReturnValue(Buffer.from('GitHub Copilot CLI 0.0.1.\n'));

      const info = checkCliCompatibility();
      expect(info.version).toBe('0.0.1');
      expect(info.compatible).toBe(true);
    });
  });

  // ── isCliMxcCapable ──────────────────────────────────
  //
  // The walker probes <dir>/node_modules/@microsoft/mxc-sdk at every level up
  // from `dirname(cliPath)`. These tests cover the layouts users actually
  // hit: a bundled `dist-cli/` (this is the case from the bug report — deps
  // live one level up in the repo's node_modules), a hoisted standard
  // install, a nested install, and the absent case.
  describe('isCliMxcCapable', () => {
    beforeEach(() => {
      invalidateMxcCapability();
    });

    // Drive the FS via an allow-set: existsSync returns true iff the queried
    // path is in the set. The cliPath itself must also be in the set so
    // resolveCopilotCliPath validates it. Case-insensitive on Windows.
    function setupFs(present: string[]) {
      const isWin = process.platform === 'win32';
      const allow = new Set(present.map((p) => isWin ? p.toLowerCase() : p));
      mockExistsSync.mockImplementation((p: unknown) =>
        typeof p === 'string' && allow.has(isWin ? p.toLowerCase() : p),
      );
    }

    const isWin = process.platform === 'win32';
    const cli = isWin ? 'C:\\repo\\dist-cli\\index.js' : '/repo/dist-cli/index.js';
    const mxcDir = isWin
      ? 'C:\\repo\\node_modules\\@microsoft\\mxc-sdk'
      : '/repo/node_modules/@microsoft/mxc-sdk';

    it('detects mxc-sdk in a bundled dist-cli layout (deps in parent node_modules)', () => {
      mockGetConfigValue.mockReturnValue(cli);
      setupFs([cli, mxcDir]);

      expect(isCliMxcCapable()).toBe(true);
    });

    it('detects mxc-sdk in a hoisted standard install layout', () => {
      const hoistedCli = isWin
        ? 'C:\\prefix\\node_modules\\@github\\copilot\\index.js'
        : '/prefix/node_modules/@github/copilot/index.js';
      const hoistedMxc = isWin
        ? 'C:\\prefix\\node_modules\\@microsoft\\mxc-sdk'
        : '/prefix/node_modules/@microsoft/mxc-sdk';
      mockGetConfigValue.mockReturnValue(hoistedCli);
      setupFs([hoistedCli, hoistedMxc]);

      expect(isCliMxcCapable()).toBe(true);
    });

    it('detects mxc-sdk in a nested install layout', () => {
      const nestedCli = isWin
        ? 'C:\\prefix\\node_modules\\@github\\copilot\\index.js'
        : '/prefix/node_modules/@github/copilot/index.js';
      const nestedMxc = isWin
        ? 'C:\\prefix\\node_modules\\@github\\copilot\\node_modules\\@microsoft\\mxc-sdk'
        : '/prefix/node_modules/@github/copilot/node_modules/@microsoft/mxc-sdk';
      mockGetConfigValue.mockReturnValue(nestedCli);
      setupFs([nestedCli, nestedMxc]);

      expect(isCliMxcCapable()).toBe(true);
    });

    it('returns false when mxc-sdk is not present at any level', () => {
      mockGetConfigValue.mockReturnValue(cli);
      setupFs([cli]); // no mxc-sdk anywhere
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(isCliMxcCapable()).toBe(false);
      // Logged the searched directories for debuggability.
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('@microsoft/mxc-sdk not found'));
      warnSpy.mockRestore();
    });

    it('returns false when no CLI path can be resolved', () => {
      mockGetConfigValue.mockReturnValue(null);
      mockExistsSync.mockReturnValue(false);
      mockExecSync.mockImplementation(() => { throw new Error('not found'); });

      expect(isCliMxcCapable()).toBe(false);
    });

    it('caches the result after the first call', () => {
      mockGetConfigValue.mockReturnValue(cli);
      setupFs([cli, mxcDir]);

      expect(isCliMxcCapable()).toBe(true);
      const firstCallCount = mockExistsSync.mock.calls.length;

      // Second call must not re-stat the FS.
      expect(isCliMxcCapable()).toBe(true);
      expect(mockExistsSync.mock.calls.length).toBe(firstCallCount);
    });

    it('re-probes after invalidateMxcCapability()', () => {
      mockGetConfigValue.mockReturnValue(cli);
      // First probe: no mxc-sdk → false.
      setupFs([cli]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(isCliMxcCapable()).toBe(false);

      // Now the SDK appears, but cache still says false until invalidated.
      setupFs([cli, mxcDir]);
      expect(isCliMxcCapable()).toBe(false);

      invalidateMxcCapability();
      expect(isCliMxcCapable()).toBe(true);
      warnSpy.mockRestore();
    });

    it('stops searching at the filesystem root without infinite-looping', () => {
      // cliPath is at root; walker should bail at parent === dir.
      const rootCli = isWin ? 'C:\\index.js' : '/index.js';
      mockGetConfigValue.mockReturnValue(rootCli);
      setupFs([rootCli]);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(isCliMxcCapable()).toBe(false);
      warnSpy.mockRestore();
    });

    it('detects mxc-bin directory in self-updated CLI layout', () => {
      const selfUpdatedCli = isWin
        ? 'C:\\Users\\test\\AppData\\Local\\copilot\\pkg\\universal\\1.0.57-3\\index.js'
        : '/home/test/.local/copilot/pkg/universal/1.0.57-3/index.js';
      const mxcBin = isWin
        ? 'C:\\Users\\test\\AppData\\Local\\copilot\\pkg\\universal\\1.0.57-3\\mxc-bin'
        : '/home/test/.local/copilot/pkg/universal/1.0.57-3/mxc-bin';
      mockGetConfigValue.mockReturnValue(selfUpdatedCli);
      setupFs([selfUpdatedCli, mxcBin]);

      expect(isCliMxcCapable()).toBe(true);
    });
  });
});
