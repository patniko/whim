import { describe, expect, it, vi } from 'vitest';

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
import { webAccessFor, webAllowedChannels } from '../../shared/web-access';

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

  it('reports the remaining parity gap, so it cannot grow unnoticed', () => {
    // Commands we have decided are safe remotely but have not built a gateway
    // adapter for yet. Shrinking this list is the parity work; this test
    // exists so the list is visible in review rather than invisible.
    const implemented = new Set<string>(WEB_REMOTE_IMPLEMENTED_CHANNELS);
    const pending = webAllowedChannels().filter((channel) => !implemented.has(channel));

    // A ratchet, not a target: it may shrink freely, but growing it requires
    // deliberately editing this number.
    expect(pending.length).toBeLessThanOrEqual(35);
    // None of the interaction commands may ever be in the pending list.
    for (const channel of ['agent:approve', 'agent:respond-user-input', 'agent:respond-elicitation', 'agent:resolve-sandbox']) {
      expect(pending).not.toContain(channel);
    }
  });
});

describe('settings key filtering', () => {
  it('serves a setting the interface needs to boot', async () => {
    // Resolving at all is the assertion: the value depends on config, but a
    // refusal here would stop the web interface from mounting.
    await expect(invokeWebRemoteCommand('settings:get', ['workspace_root'])).resolves.toBeDefined();
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

  it('refuses writing settings entirely', async () => {
    await expect(invokeWebRemoteCommand('settings:set', ['theme', 'dark']))
      .rejects.toThrow(/not available/i);
  });
});
