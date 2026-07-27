import { describe, expect, it } from 'vitest';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  describeUserAgent,
  DeviceSessionStore,
  extractSessionCookie,
  parseCookies,
  SESSION_COOKIE_NAME,
  type WebRemoteDeviceRecord,
} from './sessions';

function makeStore() {
  let records: WebRemoteDeviceRecord[] = [];
  const store = new DeviceSessionStore({
    load: () => records,
    save: (next) => { records = next; },
  });
  return { store, all: () => records };
}

describe('parseCookies', () => {
  it('parses a cookie header', () => {
    expect(parseCookies('a=1; b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('url-decodes values', () => {
    expect(parseCookies('a=one%20two')).toEqual({ a: 'one two' });
  });

  it('tolerates a missing header', () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it('extracts the session cookie', () => {
    expect(extractSessionCookie({ cookie: `x=1; ${SESSION_COOKIE_NAME}=abc.def` })).toBe('abc.def');
    expect(extractSessionCookie({})).toBeNull();
  });
});

describe('buildSessionCookie', () => {
  it('is HttpOnly and SameSite=Strict', () => {
    const cookie = buildSessionCookie('abc.def', { secure: false });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('only sets Secure over HTTPS, since a browser drops a Secure cookie on http://', () => {
    expect(buildSessionCookie('a.b', { secure: false })).not.toContain('Secure');
    expect(buildSessionCookie('a.b', { secure: true })).toContain('Secure');
  });

  it('expires the cookie when cleared', () => {
    expect(buildClearedSessionCookie()).toContain('Max-Age=0');
  });
});

describe('describeUserAgent', () => {
  it('produces a recognizable device name', () => {
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Safari/605.1'))
      .toBe('iPhone · Safari');
    expect(describeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36'))
      .toBe('Mac · Chrome');
  });

  it('degrades gracefully', () => {
    expect(describeUserAgent(undefined)).toBe('Unknown device');
  });
});

describe('DeviceSessionStore', () => {
  it('issues a session that verifies', () => {
    const { store } = makeStore();
    const issued = store.issue('Mozilla/5.0 (iPhone)', '192.168.1.9');
    expect(store.verify(issued.cookieValue, '192.168.1.9')?.id).toBe(issued.record.id);
  });

  it('never persists the raw secret', () => {
    const { store, all } = makeStore();
    const issued = store.issue(undefined, undefined);
    const secret = issued.cookieValue.split('.')[1];
    expect(JSON.stringify(all())).not.toContain(secret);
  });

  it('rejects a tampered secret', () => {
    const { store } = makeStore();
    const issued = store.issue(undefined, undefined);
    const [id] = issued.cookieValue.split('.');
    expect(store.verify(`${id}.wrong-secret`, undefined)).toBeNull();
  });

  it('rejects an unknown device id', () => {
    const { store } = makeStore();
    store.issue(undefined, undefined);
    expect(store.verify('nope.secret', undefined)).toBeNull();
  });

  it('rejects malformed cookie values', () => {
    const { store } = makeStore();
    expect(store.verify(null, undefined)).toBeNull();
    expect(store.verify('nodot', undefined)).toBeNull();
    expect(store.verify('.leading', undefined)).toBeNull();
  });

  it('revokes one device without affecting the others', () => {
    const { store } = makeStore();
    const a = store.issue('Mozilla/5.0 (iPhone)', '10.0.0.1');
    const b = store.issue('Mozilla/5.0 (Macintosh)', '10.0.0.2');

    expect(store.revoke(a.record.id)).toBe(true);
    expect(store.verify(a.cookieValue, undefined)).toBeNull();
    expect(store.verify(b.cookieValue, undefined)?.id).toBe(b.record.id);
  });

  it('revokes everything at once', () => {
    const { store } = makeStore();
    const a = store.issue(undefined, undefined);
    store.revokeAll();
    expect(store.verify(a.cookieValue, undefined)).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('does not leak the secret hash to the UI listing', () => {
    const { store } = makeStore();
    store.issue('Mozilla/5.0 (iPhone)', '10.0.0.1');
    expect(store.list()[0]).not.toHaveProperty('secretHash');
  });

  it('refreshes last-seen metadata on use', () => {
    let clock = 1_000;
    let records: WebRemoteDeviceRecord[] = [];
    const store = new DeviceSessionStore({
      load: () => records,
      save: (next) => { records = next; },
      now: () => clock,
    });

    const issued = store.issue(undefined, '10.0.0.1');
    clock = 60_000;
    store.verify(issued.cookieValue, '10.0.0.2');

    expect(records[0].lastSeenAt).toBe(new Date(60_000).toISOString());
    expect(records[0].lastAddress).toBe('10.0.0.2');
  });
});
