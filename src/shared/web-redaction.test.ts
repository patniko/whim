import { describe, expect, it } from 'vitest';
import { redactWebResult, REDACTED_TARGET } from './web-redaction';
import { webAccessFor } from './web-access';

describe('cli:runtime-status over the web remote', () => {
  /**
   * The channel was denied outright, and the renderer reads it during boot to
   * decide between the setup flow and the real interface — so the deny did not
   * hide a path so much as stop the browser interface from ever starting.
   */
  it('is reachable, because boot cannot branch without it', () => {
    expect(webAccessFor('cli:runtime-status')).toBe('allow');
  });

  it('never sends the host filesystem path', () => {
    const redacted = redactWebResult('cli:runtime-status', {
      source: 'auto',
      target: '/Users/someone/.local/bin/copilot',
      version: '0.9.1',
      compatible: true,
      minVersion: '0.8.0',
    }) as Record<string, unknown>;

    expect(redacted.target).toBe(REDACTED_TARGET);
    expect(JSON.stringify(redacted)).not.toContain('/Users/someone');
  });

  /**
   * Redaction must not become a lie. The remaining fields decide whether the
   * user is shown the interface or an "update your CLI" prompt, and inventing
   * a friendly answer for either would strand them.
   */
  it('passes the fields boot actually branches on through untouched', () => {
    const redacted = redactWebResult('cli:runtime-status', {
      source: 'server',
      target: 'https://runtime.internal',
      version: '0.1.0',
      compatible: false,
      minVersion: '0.8.0',
    }) as Record<string, unknown>;

    expect(redacted.source).toBe('server');
    expect(redacted.version).toBe('0.1.0');
    expect(redacted.compatible).toBe(false);
    expect(redacted.minVersion).toBe('0.8.0');
  });

  /**
   * A server URL can carry a hostname and a token as readily as a path can
   * carry a username, so it is redacted on the same terms.
   */
  it('redacts a remote runtime URL too', () => {
    const redacted = redactWebResult('cli:runtime-status', {
      source: 'server',
      target: 'https://user:secret@runtime.internal:8443',
    }) as Record<string, unknown>;

    expect(redacted.target).toBe(REDACTED_TARGET);
  });

  /**
   * "No runtime configured" is the signal boot uses to show setup. Replacing
   * null with the marker would claim a runtime that isn't there and send the
   * user into an interface that cannot launch anything.
   */
  it('keeps "there is no runtime" distinguishable from "there is one"', () => {
    const redacted = redactWebResult('cli:runtime-status', {
      source: 'auto',
      target: null,
      compatible: false,
    }) as Record<string, unknown>;

    expect(redacted.target).toBeNull();
  });
});

describe('redactWebResult', () => {
  it('leaves channels with no redactor exactly as they were', () => {
    const spaces = [{ id: 's1', title: 'Ship it' }];
    expect(redactWebResult('space:list', spaces)).toBe(spaces);
  });

  it('survives a handler that answered with null', () => {
    expect(redactWebResult('cli:runtime-status', null)).toBeNull();
  });

  /**
   * The redactor used to spread the handler's reply and replace one field, so
   * anything added to the runtime status later would have reached the browser
   * unredacted, with no test failing. It now names the fields it forwards, and
   * this pins that: an unclassified field is dropped rather than passed on.
   */
  it('drops a field nobody has classified instead of forwarding it', () => {
    const redacted = redactWebResult('cli:runtime-status', {
      source: 'auto',
      target: null,
      version: '0.9.1',
      compatible: true,
      minVersion: '0.8.0',
      configPath: '/Users/someone/.config/whim/cli.json',
      lastError: 'ENOENT /Users/someone/.local/bin/copilot',
    }) as Record<string, unknown>;

    expect(redacted).not.toHaveProperty('configPath');
    expect(redacted).not.toHaveProperty('lastError');
    expect(JSON.stringify(redacted)).not.toContain('/Users/someone');
  });

  it('answers with exactly the fields the contract declares', () => {
    const redacted = redactWebResult('cli:runtime-status', {
      source: 'auto',
      target: '/opt/copilot',
      version: '1.0.0',
      compatible: true,
      minVersion: '0.8.0',
    }) as Record<string, unknown>;

    expect(Object.keys(redacted).sort())
      .toEqual(['compatible', 'minVersion', 'source', 'target', 'version']);
  });
});
