/**
 * Per-device sessions for the web remote.
 *
 * The bootstrap token is a *bearer* credential: whoever holds the URL holds
 * full control of the machine. Keeping it in the address bar means it leaks
 * into browser history and `Referer` headers, and a single global token can
 * only be revoked by rotating it for every device at once.
 *
 * So the token is exchanged once for a per-device session: the browser gets an
 * `HttpOnly` cookie, the server keeps only a hash of the secret, and each
 * device can be revoked individually.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import type { WebRemoteDevice } from '../../shared/ipc-contract';

export const SESSION_COOKIE_NAME = 'whim_session';

export interface WebRemoteDeviceRecord extends WebRemoteDevice {
  /** SHA-256 of the session secret. The secret itself is never persisted. */
  secretHash: string;
}

export interface IssuedSession {
  record: WebRemoteDeviceRecord;
  /** `id.secret` — the value handed to the browser as a cookie. */
  cookieValue: string;
}

const MAX_DEVICES = 32;

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf-8');
  const right = Buffer.from(b, 'utf-8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result[name] = decodeURIComponent(value);
  }
  return result;
}

export function extractSessionCookie(headers: IncomingHttpHeaders): string | null {
  return parseCookies(headers.cookie)[SESSION_COOKIE_NAME] ?? null;
}

/**
 * Derive a human-recognizable device name from the User-Agent so the settings
 * list is actually actionable ("revoke the iPhone") rather than a list of ids.
 */
export function describeUserAgent(userAgent: string | undefined): string {
  if (!userAgent) return 'Unknown device';
  const platform = /iPhone/.test(userAgent) ? 'iPhone'
    : /iPad/.test(userAgent) ? 'iPad'
    : /Android/.test(userAgent) ? 'Android'
    : /Mac OS X/.test(userAgent) ? 'Mac'
    : /Windows/.test(userAgent) ? 'Windows'
    : /Linux/.test(userAgent) ? 'Linux'
    : 'Browser';
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /OPR\//.test(userAgent) ? 'Opera'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'browser';
  return `${platform} · ${browser}`;
}

export interface DeviceSessionStoreOptions {
  load: () => WebRemoteDeviceRecord[];
  save: (records: WebRemoteDeviceRecord[]) => void;
  now?: () => number;
}

export class DeviceSessionStore {
  private readonly now: () => number;

  constructor(private readonly options: DeviceSessionStoreOptions) {
    this.now = options.now ?? Date.now;
  }

  list(): WebRemoteDevice[] {
    return this.records().map(({ secretHash: _secretHash, ...device }) => device);
  }

  issue(userAgent: string | undefined, address: string | undefined): IssuedSession {
    const id = randomBytes(9).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const timestamp = new Date(this.now()).toISOString();

    const record: WebRemoteDeviceRecord = {
      id,
      label: describeUserAgent(userAgent),
      createdAt: timestamp,
      lastSeenAt: timestamp,
      lastAddress: address ?? null,
      userAgent: userAgent ?? null,
      secretHash: hashSecret(secret),
    };

    // Oldest-first eviction keeps the list bounded without ever silently
    // dropping the session that is actively in use.
    const records = [...this.records(), record]
      .sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt))
      .slice(-MAX_DEVICES);
    this.options.save(records);

    return { record, cookieValue: `${id}.${secret}` };
  }

  /** Returns the matching device, refreshing its last-seen metadata. */
  verify(cookieValue: string | null, address: string | undefined): WebRemoteDevice | null {
    if (!cookieValue) return null;
    const separator = cookieValue.indexOf('.');
    if (separator <= 0) return null;

    const id = cookieValue.slice(0, separator);
    const secret = cookieValue.slice(separator + 1);
    const records = this.records();
    const match = records.find((record) => record.id === id);
    if (!match || !constantTimeEqual(hashSecret(secret), match.secretHash)) return null;

    match.lastSeenAt = new Date(this.now()).toISOString();
    match.lastAddress = address ?? match.lastAddress;
    this.options.save(records);

    const { secretHash: _secretHash, ...device } = match;
    return device;
  }

  revoke(deviceId: string): boolean {
    const records = this.records();
    const remaining = records.filter((record) => record.id !== deviceId);
    if (remaining.length === records.length) return false;
    this.options.save(remaining);
    return true;
  }

  revokeAll(): void {
    this.options.save([]);
  }

  private records(): WebRemoteDeviceRecord[] {
    const loaded = this.options.load();
    return Array.isArray(loaded) ? loaded.filter(isRecord) : [];
  }
}

function isRecord(value: unknown): value is WebRemoteDeviceRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.secretHash === 'string';
}

export interface SessionCookieOptions {
  /** `Secure` is only set over HTTPS — a browser drops a Secure cookie on http://. */
  secure: boolean;
  maxAgeSeconds?: number;
}

export function buildSessionCookie(value: string, options: SessionCookieOptions): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds ?? 60 * 60 * 24 * 365}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
