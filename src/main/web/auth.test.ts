import { describe, expect, it } from 'vitest';
import { constantTimeTokenEqual, extractWebSocketProtocolToken, WebRemoteAuthenticator } from './auth';

describe('web remote auth', () => {
  it('compares tokens by digest', () => {
    expect(constantTimeTokenEqual('secret-token', 'secret-token')).toBe(true);
    expect(constantTimeTokenEqual('secret-token', 'other-token')).toBe(false);
  });

  it('accepts valid tokens and rejects invalid tokens', () => {
    const auth = new WebRemoteAuthenticator(() => 'secret-token');

    expect(auth.authenticate('secret-token', '127.0.0.1').ok).toBe(true);
    const rejected = auth.authenticate('wrong', '127.0.0.1');
    expect(rejected.ok).toBe(false);
    expect(rejected.status).toBe(401);
  });

  it('locks out repeated failures by address', () => {
    const auth = new WebRemoteAuthenticator(() => 'secret-token');

    for (let i = 0; i < 5; i++) {
      auth.authenticate('wrong', '100.64.0.10');
    }

    const result = auth.authenticate('secret-token', '100.64.0.10');
    expect(result.ok).toBe(false);
    expect(result.status).toBe(429);
  });

  it('extracts websocket protocol tokens', () => {
    expect(extractWebSocketProtocolToken('chat, whim-token.abc123')).toBe('abc123');
    expect(extractWebSocketProtocolToken(undefined)).toBeNull();
  });
});

describe('lockout persistence', () => {
  it('restores an active lockout across a restart', () => {
    const lockedUntil = Date.now() + 60_000;
    const auth = new WebRemoteAuthenticator(() => 'expected');
    auth.hydrate([{ key: '10.0.0.5', lockedUntil }]);
    // The correct token must still be refused while the lockout stands,
    // otherwise restarting the app would be a free reset for an attacker.
    expect(auth.authenticate('expected', '10.0.0.5').status).toBe(429);
  });

  it('ignores a lockout that has already expired', () => {
    const auth = new WebRemoteAuthenticator(() => 'expected');
    auth.hydrate([{ key: '10.0.0.5', lockedUntil: Date.now() - 1 }]);
    expect(auth.authenticate('expected', '10.0.0.5').ok).toBe(true);
  });

  it('does not lock out unrelated addresses', () => {
    const auth = new WebRemoteAuthenticator(() => 'expected');
    auth.hydrate([{ key: '10.0.0.5', lockedUntil: Date.now() + 60_000 }]);
    expect(auth.authenticate('expected', '10.0.0.6').ok).toBe(true);
  });

  it('persists a lockout as soon as it trips', () => {
    const saved: unknown[][] = [];
    const auth = new WebRemoteAuthenticator(() => 'expected', undefined, (records) => saved.push(records));
    for (let i = 0; i < 5; i += 1) auth.authenticate('wrong', '10.0.0.5');
    expect(saved.at(-1)).toEqual([{ key: '10.0.0.5', lockedUntil: expect.any(Number) }]);
  });

  it('does not persist anything before the threshold is reached', () => {
    const saved: unknown[][] = [];
    const auth = new WebRemoteAuthenticator(() => 'expected', undefined, (records) => saved.push(records));
    auth.authenticate('wrong', '10.0.0.5');
    expect(saved).toHaveLength(0);
  });

  it('clears persisted lockouts on reset', () => {
    const saved: unknown[][] = [];
    const auth = new WebRemoteAuthenticator(() => 'expected', undefined, (records) => saved.push(records));
    auth.reset();
    expect(saved.at(-1)).toEqual([]);
  });
});
