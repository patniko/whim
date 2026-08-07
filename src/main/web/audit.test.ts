import { describe, expect, it } from 'vitest';
import { normalizeAddress, redactPath, WebRemoteAuditLog, WebRemoteRateLimiter } from './audit';

describe('redactPath', () => {
  it('drops the query string, which is where a token would be', () => {
    expect(redactPath('/api/events?token=supersecret&lastSeq=4')).toBe('/api/events');
  });

  it('leaves a bare path alone', () => {
    expect(redactPath('/api/invoke')).toBe('/api/invoke');
  });

  it('truncates an absurdly long path', () => {
    expect(redactPath(`/${'a'.repeat(500)}`)).toHaveLength(201);
  });
});

describe('normalizeAddress', () => {
  it('unwraps IPv6-mapped IPv4 so the same host groups together', () => {
    expect(normalizeAddress('::ffff:192.168.1.5')).toBe('192.168.1.5');
  });

  it('leaves a real IPv6 address alone', () => {
    expect(normalizeAddress('fd7a::1')).toBe('fd7a::1');
  });

  it('labels a missing address', () => {
    expect(normalizeAddress(undefined)).toBe('unknown');
  });
});

function entry(overrides: Partial<Parameters<WebRemoteAuditLog['record']>[0]> = {}) {
  return {
    at: 1, method: 'POST', path: '/api/invoke', channel: 'space:list',
    status: 200, outcome: 'ok' as const, identity: 'token',
    remoteAddress: '127.0.0.1', durationMs: 3, ...overrides,
  };
}

describe('WebRemoteAuditLog', () => {
  it('returns the newest entry first', () => {
    const log = new WebRemoteAuditLog();
    log.record(entry({ at: 1 }));
    log.record(entry({ at: 2 }));
    expect(log.recent().map((e) => e.at)).toEqual([2, 1]);
  });

  it('is bounded so a busy server cannot grow it without limit', () => {
    const log = new WebRemoteAuditLog();
    for (let i = 0; i < 500; i += 1) log.record(entry({ at: i }));
    const recent = log.recent(1000);
    expect(recent).toHaveLength(200);
    expect(recent[0].at).toBe(499);
  });

  it('honours the requested limit', () => {
    const log = new WebRemoteAuditLog();
    for (let i = 0; i < 10; i += 1) log.record(entry({ at: i }));
    expect(log.recent(3).map((e) => e.at)).toEqual([9, 8, 7]);
  });
});

describe('WebRemoteRateLimiter', () => {
  it('allows a burst up to capacity', () => {
    const limiter = new WebRemoteRateLimiter(3, 1000, () => 0);
    expect([limiter.check('a'), limiter.check('a'), limiter.check('a')].every((d) => d.allowed)).toBe(true);
  });

  it('blocks past capacity and says when to retry', () => {
    const limiter = new WebRemoteRateLimiter(2, 1000, () => 0);
    limiter.check('a');
    limiter.check('a');
    const blocked = limiter.check('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('meters each identity separately, so one device cannot starve another', () => {
    const limiter = new WebRemoteRateLimiter(1, 1000, () => 0);
    expect(limiter.check('phone').allowed).toBe(true);
    expect(limiter.check('phone').allowed).toBe(false);
    expect(limiter.check('laptop').allowed).toBe(true);
  });

  it('refills over time', () => {
    let now = 0;
    const limiter = new WebRemoteRateLimiter(2, 1000, () => now);
    limiter.check('a');
    limiter.check('a');
    expect(limiter.check('a').allowed).toBe(false);
    now = 1000;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('never refills beyond capacity', () => {
    let now = 0;
    const limiter = new WebRemoteRateLimiter(2, 1000, () => now);
    now = 1_000_000;
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  /**
   * Burst and sustained rate used to be the same number, so a burst spent the
   * whole minute's budget. A page load costs a dozen calls before it paints
   * and a reload immediately costs them again, which is exactly the pattern
   * that filled the browser console with 429s while nothing unusual was
   * happening.
   */
  it('lets a burst exceed the sustained rate without draining the minute', () => {
    let now = 0;
    const limiter = new WebRemoteRateLimiter(10, 1000, () => now, 5);

    for (let i = 0; i < 10; i++) {
      expect(limiter.check('phone').allowed).toBe(true);
    }
    expect(limiter.check('phone').allowed).toBe(false);

    // A full window later, the sustained rate — not the burst size — is what
    // has been handed back.
    now = 1000;
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('phone').allowed).toBe(true);
    }
    expect(limiter.check('phone').allowed).toBe(false);
  });

  it('still behaves as a plain token bucket when only one rate is given', () => {
    let now = 0;
    const limiter = new WebRemoteRateLimiter(2, 1000, () => now);
    limiter.check('a');
    limiter.check('a');
    expect(limiter.check('a').allowed).toBe(false);
    now = 500;
    expect(limiter.check('a').allowed).toBe(true);
  });
});
