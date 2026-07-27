import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'http';
import type { WebRemoteDevice } from '../../shared/ipc-contract';
import { extractSessionCookie, type DeviceSessionStore } from './sessions';

export interface AuthResult {
  ok: boolean;
  status: number;
  message: string;
  /** How the caller proved identity, when it succeeded. */
  via?: 'token' | 'session';
  device?: WebRemoteDevice;
}

interface FailureState {
  count: number;
  firstFailureAt: number;
  lockedUntil: number;
}

/**
 * Lockouts were previously in-memory only, so restarting the app — something
 * an attacker can trigger simply by waiting for an update, or that happens
 * naturally overnight — reset the counter to zero. Persisting the locked
 * entries makes the limit mean something.
 */
export interface WebRemoteLockoutRecord {
  key: string;
  lockedUntil: number;
}

const FAILURE_WINDOW_MS = 60_000;
const LOCKOUT_MS = 5 * 60_000;
const MAX_FAILURES = 5;

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function constantTimeTokenEqual(candidate: string, expected: string): boolean {
  return timingSafeEqual(digest(candidate), digest(expected));
}

export function extractHttpToken(headers: IncomingHttpHeaders, url: URL): string | null {
  const auth = headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();

  const headerToken = headers['x-whim-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();

  const queryToken = url.searchParams.get('token');
  return queryToken?.trim() || null;
}

export function extractWebSocketProtocolToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header.join(',') : header;
  if (!value) return null;
  for (const part of value.split(',')) {
    const protocol = part.trim();
    if (protocol.startsWith('whim-token.')) return protocol.slice('whim-token.'.length);
  }
  return null;
}

export interface AuthenticateInput {
  headers: IncomingHttpHeaders;
  url: URL;
  remoteAddress: string | undefined;
}

export class WebRemoteAuthenticator {
  private readonly failures = new Map<string, FailureState>();

  constructor(
    private readonly getExpectedToken: () => string | null | undefined,
    private readonly sessions?: DeviceSessionStore,
    private readonly persist?: (records: WebRemoteLockoutRecord[]) => void,
  ) {}

  /**
   * Reload lockouts saved by a previous run. Called at server start rather
   * than in the constructor because the authenticator is a module-level
   * singleton and must not read config at import time.
   */
  hydrate(records: readonly WebRemoteLockoutRecord[] | undefined): void {
    const now = Date.now();
    for (const record of records ?? []) {
      // Expired entries are dropped rather than resurrected.
      if (record.lockedUntil > now) {
        this.failures.set(record.key, { count: MAX_FAILURES, firstFailureAt: now, lockedUntil: record.lockedUntil });
      }
    }
  }

  /** Currently-active lockouts, for persistence. */
  activeLockouts(now = Date.now()): WebRemoteLockoutRecord[] {
    const records: WebRemoteLockoutRecord[] = [];
    for (const [key, state] of this.failures) {
      if (state.lockedUntil > now) records.push({ key, lockedUntil: state.lockedUntil });
    }
    return records;
  }

  /**
   * Accepts either a per-device session cookie or the bootstrap token.
   *
   * The cookie is checked first: it is the day-to-day credential, is scoped to
   * one device, and is individually revocable. The token remains valid so that
   * API clients and the initial pairing flow keep working.
   */
  authenticateRequest(input: AuthenticateInput): AuthResult {
    const key = input.remoteAddress || 'unknown';
    const now = Date.now();
    const current = this.failures.get(key);

    if (current && current.lockedUntil > now) {
      return { ok: false, status: 429, message: 'Too many failed attempts. Try again later.' };
    }

    const device = this.sessions?.verify(extractSessionCookie(input.headers), input.remoteAddress);
    if (device) {
      this.failures.delete(key);
      return { ok: true, status: 200, message: 'ok', via: 'session', device };
    }

    return this.authenticate(extractHttpToken(input.headers, input.url), input.remoteAddress);
  }

  authenticate(candidate: string | null | undefined, remoteAddress: string | undefined): AuthResult {
    const key = remoteAddress || 'unknown';
    const now = Date.now();
    const current = this.failures.get(key);

    if (current && current.lockedUntil > now) {
      return { ok: false, status: 429, message: 'Too many failed attempts. Try again later.' };
    }

    const expected = this.getExpectedToken();
    if (!expected) {
      return { ok: false, status: 503, message: 'Web remote token is not configured.' };
    }

    if (candidate && constantTimeTokenEqual(candidate, expected)) {
      this.failures.delete(key);
      return { ok: true, status: 200, message: 'ok', via: 'token' };
    }

    this.recordFailure(key, now);
    return { ok: false, status: 401, message: 'Invalid or missing token.' };
  }

  reset(): void {
    this.failures.clear();
    this.persist?.([]);
  }

  private recordFailure(key: string, now: number): void {
    const existing = this.failures.get(key);
    const withinWindow = existing && now - existing.firstFailureAt <= FAILURE_WINDOW_MS;
    const next: FailureState = withinWindow
      ? { ...existing, count: existing.count + 1 }
      : { count: 1, firstFailureAt: now, lockedUntil: 0 };

    if (next.count >= MAX_FAILURES) {
      next.lockedUntil = now + LOCKOUT_MS;
    }

    this.failures.set(key, next);
    if (next.lockedUntil > now) this.persist?.(this.activeLockouts(now));
  }
}

export function getRemoteAddress(req: IncomingMessage): string | undefined {
  return req.socket.remoteAddress;
}
