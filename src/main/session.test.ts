import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExistsSync, mockStatSync, mockMkdirSync, mockLaunchInTerminal } = vi.hoisted(() => ({
  mockExistsSync: vi.fn<(p: unknown) => boolean>(),
  mockStatSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockLaunchInTerminal: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/space-test', getAppPath: () => '/mock/app' },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, existsSync: mockExistsSync, statSync: mockStatSync, mkdirSync: mockMkdirSync };
});

vi.mock('./platform/terminal', () => ({ launchInTerminal: mockLaunchInTerminal }));

vi.mock('./config', () => ({
  getSessionId: vi.fn(() => 'space-session'),
  setSessionId: vi.fn(),
}));

vi.mock('./storage', () => ({
  getSpace: vi.fn(async () => ({ id: 'space-1', folder: 'space-folder', description: 'Space' })),
  assignSpaceFolder: vi.fn(),
  setSpaceSessionId: vi.fn(),
}));

vi.mock('./workspace', () => ({
  createSpaceFolder: vi.fn(),
}));

import * as path from 'path';
import { getBundledCopilotCandidates } from './copilot-runtime-path';

const bundledCli = getBundledCopilotCandidates('/mock/app')[0];

async function loadSession() {
  // The bundled CLI path is resolved once per process; isolate each case.
  vi.resetModules();
  return import('./session');
}

describe('session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockLaunchInTerminal.mockResolvedValue({ pid: 4242 });
  });

  describe('launchSession', () => {
    it('returns error when workspace directory does not exist', async () => {
      mockExistsSync.mockReturnValue(false);
      const { launchSession } = await loadSession();

      const result = await launchSession('space-1', '/nonexistent/workspace');
      expect(result).toEqual({ success: false, error: 'Workspace directory does not exist' });
    });

    it('reports a missing bundled CLI instead of looking for another install', async () => {
      mockExistsSync.mockImplementation((p: unknown) => p === '/valid/workspace');
      const { launchSession } = await loadSession();

      const result = await launchSession('space-2', '/valid/workspace');
      expect(result.success).toBe(false);
      expect(result.error).toContain('bundled with Whim is missing');
      expect(mockLaunchInTerminal).not.toHaveBeenCalled();
    });

    it("resumes the space's session with the bundled CLI in the space folder", async () => {
      mockExistsSync.mockReturnValue(true);
      const { launchSession } = await loadSession();

      const result = await launchSession('space-3', '/valid/workspace');
      expect(result).toEqual({ success: true, sessionId: 'space-session' });
      expect(mockLaunchInTerminal).toHaveBeenCalledWith({
        command: bundledCli,
        args: ['--resume=space-session'],
        cwd: path.join('/valid/workspace', 'space-folder'),
      });
    });
  });

  describe('launchCliInTerminal', () => {
    it('rejects when no terminal window opened', async () => {
      mockExistsSync.mockReturnValue(true);
      mockLaunchInTerminal.mockResolvedValue({});
      const { launchCliInTerminal } = await loadSession();

      await expect(launchCliInTerminal(['--version'], '/work')).rejects.toThrow('Could not open a terminal window.');
    });
  });
});
