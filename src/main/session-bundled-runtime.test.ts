import { afterEach, describe, expect, it, vi } from 'vitest';

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
  getSessionId: vi.fn(),
  setSessionId: vi.fn(),
}));

vi.mock('./storage', () => ({
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
import { resolveBundledCliPath } from './session';

const originalPlatform = process.platform;
const originalArch = process.arch;

function setRuntime(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'arch', { configurable: true, value: arch });
}

describe('bundled Copilot CLI resolution', () => {
  afterEach(() => {
    setRuntime(originalPlatform, originalArch);
  });

  it('targets the native executable each platform package ships', () => {
    expect(getCopilotPlatformEntrypoints('darwin', 'arm64')[0].appRelativePath)
      .toBe('node_modules/@github/copilot-darwin-arm64/copilot');
    expect(getCopilotPlatformEntrypoints('win32', 'x64')[0].appRelativePath)
      .toBe('node_modules\\@github\\copilot-win32-x64\\copilot.exe');
    expect(getCopilotPlatformEntrypoints('linux', 'x64', true)[0].appRelativePath)
      .toBe('node_modules/@github/copilot-linuxmusl-x64/copilot');
  });

  it('resolves the executable unpacked from the packaged app.asar', () => {
    setRuntime('darwin', 'arm64');
    const appPath = '/Applications/whim.app/Contents/Resources/app.asar';
    const expected = `${appPath}.unpacked/node_modules/@github/copilot-darwin-arm64/copilot`;
    mockGetAppPath.mockReturnValue(appPath);
    mockExistsSync.mockImplementation((file) => file === expected);

    expect(getBundledCopilotCandidates(appPath, 'darwin', 'arm64')).toEqual([expected]);
    expect(resolveBundledCliPath()).toBe(expected);
  });
});
