import { describe, expect, it } from 'vitest';
import type { IpcCommandChannel } from './ipc-contract';
import { WEB_ACCESS, webAccessFor, webAllowedChannels } from './web-access';

/**
 * `WEB_ACCESS` is typed `Record<IpcCommandChannel, WebAccess>`, so exhaustive-
 * ness is a compile-time guarantee. These tests cover the things the type
 * cannot: that the classification stays deliberate, and that nothing sensitive
 * quietly moves into `allow`.
 */
describe('WEB_ACCESS', () => {
  it('uses only the three known classifications', () => {
    for (const [channel, access] of Object.entries(WEB_ACCESS)) {
      expect(['allow', 'deny', 'desktop-only'], `${channel} has an unknown classification`).toContain(access);
    }
  });

  it('classifies no channel twice', () => {
    expect(new Set(Object.keys(WEB_ACCESS)).size).toBe(Object.keys(WEB_ACCESS).length);
  });

  it('withholds everything that reconfigures the machine or widens privileges', () => {
    const mustBeDenied: IpcCommandChannel[] = [
      'settings:set',
      'web-remote:set-enabled',
      'web-remote:set-config',
      'web-remote:regenerate-token',
      'web-remote:revoke-device',
      'personas:save',
      'sandbox:save-default',
      'mcp:save-custom',
      'cli-tools:save',
      'workspace:select',
      'workspace:clear',
      'app:set-remote',
    ];
    for (const channel of mustBeDenied) {
      expect(WEB_ACCESS[channel], `${channel} must not be reachable from the web remote`).toBe('deny');
    }
  });

  it('marks native-only surfaces desktop-only rather than denying them', () => {
    // The distinction matters: a remote client should degrade the UI for these
    // rather than present them as a permission failure.
    const nativeOnly: IpcCommandChannel[] = [
      'fonts:list',
      'dialog:select-folder',
      'shell:openPath',
      'shell:openExternal',
      'window:get-pinned',
      'agent:open-cli',
      'cli:launch-session',
      'skill:open-folder',
      'canvas:open-link',
      'update:install',
    ];
    for (const channel of nativeOnly) {
      expect(WEB_ACCESS[channel], `${channel} should be desktop-only`).toBe('desktop-only');
    }
  });

  it('allows the agent-interaction commands, or a stuck agent is unanswerable remotely', () => {
    const interaction: IpcCommandChannel[] = [
      'agent:approve',
      'agent:respond-user-input',
      'agent:respond-elicitation',
      'agent:resolve-sandbox',
    ];
    for (const channel of interaction) {
      expect(WEB_ACCESS[channel], `${channel} must be reachable`).toBe('allow');
    }
  });

  it('resolves a known channel and rejects an unknown one', () => {
    expect(webAccessFor('space:list')).toBe('allow');
    expect(webAccessFor('not:a:channel')).toBeNull();
  });

  it('lists only allowed channels', () => {
    expect(webAllowedChannels().every((channel) => WEB_ACCESS[channel] === 'allow')).toBe(true);
    expect(webAllowedChannels()).toContain('space:list');
    expect(webAllowedChannels()).not.toContain('settings:set');
  });
});
