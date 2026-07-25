import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockMkdirSync, mockWriteFileSync, mockGetPath } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockGetPath: vi.fn(() => '/mock/userData'),
}));

vi.mock('electron', () => ({
  app: { getPath: mockGetPath },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, mkdirSync: mockMkdirSync, writeFileSync: mockWriteFileSync };
});

import { buildShimContent, getCliShimPath } from './cli-electron-shim';

describe('cli-electron-shim', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPath.mockReturnValue('/mock/userData');
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  describe('buildShimContent', () => {
    it('strips Electron and Chromium versions before importing real CLI', () => {
      const content = buildShimContent('/usr/local/bin/copilot/index.js');
      expect(content).toContain('delete process.versions.electron');
      expect(content).toContain('delete process.versions.chrome');
      expect(content).toContain("'/usr/local/bin/copilot/index.js'");
      expect(content).toContain('import(pathToFileURL(target).href)');
    });

    it('emits CommonJS so the SDK treats the shim as a .js file', () => {
      const content = buildShimContent('/usr/local/bin/copilot/index.js');
      // Must use require (not import) so Node parses it as CJS; the SDK
      // tries to spawn .mjs files directly which fails with EFTYPE on Windows.
      expect(content).toContain("require('node:url')");
      expect(content).not.toMatch(/^\s*import\s+/m);
      expect(content).not.toMatch(/^\s*await\s+/m);
    });

    it('exits non-zero if the import fails', () => {
      const content = buildShimContent('/usr/local/bin/copilot/index.js');
      expect(content).toContain('process.exit(1)');
    });

    it('escapes Windows backslashes in the target path', () => {
      const content = buildShimContent('C:\\Users\\test\\copilot\\index.js');
      expect(content).toContain("'C:\\\\Users\\\\test\\\\copilot\\\\index.js'");
    });

    it('escapes single quotes in the target path', () => {
      const content = buildShimContent("/tmp/it's/index.js");
      expect(content).toContain("'/tmp/it\\'s/index.js'");
    });
  });

  describe('getCliShimPath', () => {
    it('writes a shim for JavaScript entrypoints on non-Windows platforms', () => {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      expect(getCliShimPath('/usr/lib/copilot/index.js'))
        .toBe('/mock/userData/cli-shim/cli-electron-shim.js');
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/mock/userData/cli-shim/cli-electron-shim.js',
        expect.stringContaining('/usr/lib/copilot/index.js'),
        'utf8',
      );
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        '/mock/userData/cli-shim/package.json',
        '{"type":"commonjs"}\n',
        'utf8',
      );
    });

    it('returns null when realCliPath is empty', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(getCliShimPath('')).toBeNull();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('returns null for native executables', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      expect(getCliShimPath('C:\\ProgramData\\npm\\node_modules\\@github\\copilot-win32-x64\\copilot.exe')).toBeNull();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('writes shim file under userData/cli-shim on Windows and returns its path', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      mockGetPath.mockReturnValue('C:\\Users\\test\\AppData\\Roaming\\whim');

      const result = getCliShimPath('C:\\Users\\test\\AppData\\Local\\copilot\\pkg\\universal\\1.0.57-3\\index.js');

      // Must be .js (not .mjs) — the SDK only spawns .js files via Node.
      expect(result).toBe('C:\\Users\\test\\AppData\\Roaming\\whim\\cli-shim\\cli-electron-shim.js');
      expect(mockMkdirSync).toHaveBeenCalledWith(
        'C:\\Users\\test\\AppData\\Roaming\\whim\\cli-shim',
        { recursive: true },
      );
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2);
      const writeCall = mockWriteFileSync.mock.calls[1];
      expect(writeCall[0]).toBe('C:\\Users\\test\\AppData\\Roaming\\whim\\cli-shim\\cli-electron-shim.js');
      expect(writeCall[1]).toContain('delete process.versions.electron');
      expect(writeCall[1]).toContain('1.0.57-3');
      expect(writeCall[2]).toBe('utf8');
    });

    it('returns null if writing the shim fails', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      mockWriteFileSync.mockImplementationOnce(() => { throw new Error('EACCES'); });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(getCliShimPath('C:\\copilot\\index.js')).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to materialize Electron shim'),
        expect.any(Error),
      );

      warnSpy.mockRestore();
    });

    it('regenerates the shim on every call to keep content in sync', () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      getCliShimPath('C:\\copilot\\v1\\index.js');
      getCliShimPath('C:\\copilot\\v2\\index.js');

      expect(mockWriteFileSync).toHaveBeenCalledTimes(4);
      expect(mockWriteFileSync.mock.calls[1][1]).toContain('v1');
      expect(mockWriteFileSync.mock.calls[3][1]).toContain('v2');
    });
  });
});
