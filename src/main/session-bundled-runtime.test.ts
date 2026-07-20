import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockExistsSync, mockGetAppPath } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(file: unknown) => boolean>(),
  mockGetAppPath: vi.fn<() => string>(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: mockGetAppPath,
    getPath: vi.fn(() => ''),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: mockExistsSync };
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

import {
  getBundledCopilotCandidates,
  getCopilotPlatformEntrypoints,
} from './copilot-runtime-path';
import {
  invalidateCliPath,
  resolveBundledCliPath,
  resolveCmdToJs,
} from './session';

const originalPlatform = process.platform;
const originalArch = process.arch;

function setRuntime(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'arch', { configurable: true, value: arch });
}

describe('bundled Copilot platform runtime resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateCliPath();
  });

  afterEach(() => {
    setRuntime(originalPlatform, originalArch);
  });

  it('defines the exact platform entrypoint contract for every packaged platform', () => {
    expect(getCopilotPlatformEntrypoints('darwin', 'arm64')[0].appRelativePath)
      .toBe('node_modules/@github/copilot-darwin-arm64/index.js');
    expect(getCopilotPlatformEntrypoints('win32', 'x64')[0].appRelativePath)
      .toBe('node_modules\\@github\\copilot-win32-x64\\index.js');
    expect(getCopilotPlatformEntrypoints('linux', 'x64', true)[0].appRelativePath)
      .toBe('node_modules/@github/copilot-linuxmusl-x64/index.js');
  });

  it('resolves the packaged app.asar.unpacked platform entrypoint', () => {
    setRuntime('darwin', 'arm64');
    const appPath = '/Applications/whim.app/Contents/Resources/app.asar';
    const expected = `${appPath}.unpacked/node_modules/@github/copilot-darwin-arm64/index.js`;
    mockGetAppPath.mockReturnValue(appPath);
    mockExistsSync.mockImplementation((file) => file === expected);

    expect(resolveBundledCliPath()).toBe(expected);
    expect(getBundledCopilotCandidates(appPath, 'darwin', 'arm64')[0]).toBe(expected);
  });

  it('resolves Windows npm shims to the 1.0.71 platform entrypoint', () => {
    setRuntime('win32', 'x64');
    const expected = 'C:\\ProgramData\\npm\\node_modules\\@github\\copilot-win32-x64\\index.js';
    mockExistsSync.mockImplementation((file) => file === expected);

    expect(resolveCmdToJs('C:\\ProgramData\\npm\\copilot.cmd')).toBe(expected);
  });

  it('retains the legacy index.js fallback', () => {
    setRuntime('win32', 'x64');
    const expected = 'C:\\ProgramData\\npm\\node_modules\\@github\\copilot\\index.js';
    mockExistsSync.mockImplementation((file) => file === expected);

    expect(resolveCmdToJs('C:\\ProgramData\\npm\\copilot.cmd')).toBe(expected);
  });
});
