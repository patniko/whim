import { describe, expect, it, vi } from 'vitest';

// The registry installs handlers on ipcMain; the test only cares that it also
// records them, so a stub is enough to keep Electron out of the test process.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('../database', () => ({
  assignSpaceFolder: vi.fn(),
  createSpace: vi.fn(),
  deleteAgentSession: vi.fn(),
  getSpace: vi.fn(),
  isInitialized: vi.fn(() => true),
  listSpaceEvents: vi.fn(() => []),
  listSpaces: vi.fn(() => [{ id: 'space-1', description: 'Test space' }]),
  searchSpaces: vi.fn(() => []),
  updateCanvasContent: vi.fn(),
}));

vi.mock('../ai', () => ({
  classifyInput: vi.fn(async () => ({ type: 'space' })),
  listAvailableModels: vi.fn(async () => []),
  resolveDateWithAI: vi.fn(async () => null),
}));

vi.mock('../config', () => ({
  DEFAULT_PERSONAS: [{ id: 'default-agent', handle: 'agent', instructions: 'help', model: '', runLocation: 'local' }],
  getConfigValue: vi.fn((key: string) => key === 'personas' ? [] : null),
}));

vi.mock('../workspace', () => ({
  materializeSpaceCanvas: vi.fn(),
  readCanvas: vi.fn(() => '# canvas'),
  resolveSpaceFolder: vi.fn((workspace: string, folder: string) => `${workspace}/${folder}`),
  scheduleAutoCommit: vi.fn(),
  sanitizePageName: vi.fn((name: string) => name.trim().replace(/\.md$/, '')),
  writeCanvas: vi.fn(),
  initSpaceCanvas: vi.fn(() => 'folder'),
}));

vi.mock('../services/space-processing', () => ({
  processSpaceInBackground: vi.fn(),
}));

vi.mock('../canvas-watcher', () => ({
  markSelfWrite: vi.fn(),
}));

vi.mock('../notify', () => ({
  notifyAllWindows: vi.fn(),
}));

import { GatewayError, invokeWebRemoteCommand, isAllowedWebRemoteCommand, WEB_REMOTE_IMPLEMENTED_CHANNELS } from './gateway';
import { webAccessFor } from '../../shared/web-access';
import { registerIpcHandler } from '../ipc/registry';

describe('web remote gateway', () => {
  it('allows only reviewed channels', () => {
    expect(isAllowedWebRemoteCommand('space:list')).toBe(true);
    expect(isAllowedWebRemoteCommand('chat:send-message')).toBe(true);
    expect(isAllowedWebRemoteCommand('settings:set')).toBe(false);
    expect(isAllowedWebRemoteCommand('shell:openExternal')).toBe(false);
  });

  it('allows canvas, agent-launch and git-sync channels', () => {
    for (const channel of [
      'canvas:read', 'canvas:write', 'canvas:close', 'canvas:history',
      'canvas:restore', 'canvas:list-pages', 'agent:launch', 'agent:list',
      'workspace:git-status', 'workspace:git-push', 'workspace:git-pull',
    ]) {
      expect(isAllowedWebRemoteCommand(channel)).toBe(true);
    }
    // Mutating workspace/settings channels remain denied.
    expect(isAllowedWebRemoteCommand('workspace:clear')).toBe(false);
    expect(isAllowedWebRemoteCommand('canvas:export')).toBe(false);
  });

  it('rejects denied channels before dispatch', async () => {
    await expect(invokeWebRemoteCommand('settings:set', ['cli_path', '/tmp/evil'])).rejects.toMatchObject({
      code: 'channel_not_allowed',
      status: 403,
    } satisfies Partial<GatewayError>);
  });

  it('dispatches allowed read channels', async () => {
    await expect(invokeWebRemoteCommand('space:list', [])).resolves.toEqual([
      { id: 'space-1', description: 'Test space' },
    ]);
  });
});

describe('classification and implementation stay in sync', () => {
  it('never implements a channel that is not classified allow', () => {
    // This is the invariant that actually prevents accidental exposure: an
    // implementation alone is not enough to reach the network.
    const wronglyImplemented = WEB_REMOTE_IMPLEMENTED_CHANNELS
      .filter((channel) => webAccessFor(channel) !== 'allow');
    expect(wronglyImplemented).toEqual([]);
  });

  it('refuses a denied channel even though it exists on the desktop', () => {
    expect(isAllowedWebRemoteCommand('settings:set')).toBe(false);
    expect(isAllowedWebRemoteCommand('workspace:select')).toBe(false);
  });

  it('refuses an unknown channel', () => {
    expect(isAllowedWebRemoteCommand('not:a:channel')).toBe(false);
  });

  it('reaches an allowed channel through the desktop handler', async () => {
    // The gateway holds no adapter for `skill:list`; it is reachable purely
    // because the desktop registered a handler for it. This is the property
    // that replaced hand-porting, so it is worth pinning: registering a
    // handler is what makes an allowed channel work over the web.
    expect(isAllowedWebRemoteCommand('skill:list')).toBe(false);
    registerIpcHandler('skill:list', () => [{ name: 'a-skill' }]);
    expect(isAllowedWebRemoteCommand('skill:list')).toBe(true);
    await expect(invokeWebRemoteCommand('skill:list', [])).resolves.toEqual([{ name: 'a-skill' }]);
  });

  it('still refuses a denied channel that the desktop has registered', async () => {
    // Registration must never be enough on its own — classification decides.
    registerIpcHandler('settings:set', () => ({ ok: true }));
    expect(isAllowedWebRemoteCommand('settings:set')).toBe(false);
    await expect(invokeWebRemoteCommand('settings:set', ['theme', 'dark'])).rejects.toThrow();
  });

  it('refuses a credential even though the channel is allowed', async () => {
    // The channel is classified `allow`; the protection is per key. If this
    // ever passes, the CLI server token is readable by any paired browser.
    await expect(invokeWebRemoteCommand('settings:get', ['cli_server_token']))
      .rejects.toThrow(/not readable/i);
  });

  it('refuses an unlisted setting', async () => {
    await expect(invokeWebRemoteCommand('settings:get', ['sandbox_policy']))
      .rejects.toThrow(/not readable/i);
  });

  /**
   * `agent:disable-sandbox` is denied, but answering a sandbox prompt with
   * `disable` reaches the same `disableSandboxForSession`. Allowing this
   * channel wholesale handed a remote caller the escalation the deny existed
   * to prevent.
   */
  it('refuses to disable the sandbox through the approval channel', async () => {
    await expect(invokeWebRemoteCommand('agent:resolve-sandbox', ['agent-1', 'req-1', 'disable']))
      .rejects.toThrow(/only possible on the desktop/i);
  });

  it('still lets a remote client approve a single blocked operation', async () => {
    // It gets past the guard and on to the real handler, which needs an
    // Electron app this suite does not provide — so the guard is what is
    // being asserted here, not the outcome of the approval.
    await expect(invokeWebRemoteCommand('agent:resolve-sandbox', ['agent-1', 'req-1', 'allow-once']))
      .rejects.not.toThrow(/only possible on the desktop/i);
  });

  it('refuses writing settings entirely', async () => {
    await expect(invokeWebRemoteCommand('settings:set', ['theme', 'dark']))
      .rejects.toThrow(/not available/i);
  });
});
