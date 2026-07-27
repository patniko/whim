import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';

const TOKEN = 'test-token-0123456789';

const config = {
  webRemoteEnabled: true,
  webRemotePort: 0,
  webRemoteToken: TOKEN,
  webRemoteBindSelections: [{ kind: 'address', address: '127.0.0.1' }],
  webRemoteTlsMode: 'auto' as const,
  webRemoteTlsCertPath: '',
  webRemoteTlsKeyPath: '',
  webRemoteAllowedHosts: [] as string[],
  webRemoteDevices: [] as unknown[],
  webRemoteLockouts: [] as unknown[],
  workspace: '/tmp/workspace',
};

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/whim-test' },
}));

vi.mock('../config', () => ({
  getConfig: () => config,
  getConfigValue: (key: string) => (config as Record<string, unknown>)[key],
  ensureWebRemoteToken: () => config.webRemoteToken,
  normalizeWebRemotePort: (value: unknown) => Number(value) || 0,
  setConfigValue: (key: string, value: unknown) => { (config as Record<string, unknown>)[key] = value; },
}));

vi.mock('./gateway', async () => {
  const actual = await vi.importActual<typeof import('./gateway')>('./gateway');
  return {
    GatewayError: actual.GatewayError,
    invokeWebRemoteCommand: vi.fn(async (channel: string) => ({ echoed: channel })),
  };
});

vi.mock('./event-hub', () => ({
  subscribeWebRemoteEvents: () => () => {},
}));

const space: { id: string; folder: string } | null = { id: 'sp1', folder: 'space-one' };
let attachmentPath: string | null = null;

vi.mock('../database', () => ({
  isInitialized: () => true,
  getSpace: (id: string) => (space && space.id === id ? space : null),
}));

vi.mock('../workspace', () => ({
  resolveAttachmentPath: () => attachmentPath,
  getMimeType: () => 'image/png',
}));

vi.mock('qrcode', () => ({
  toDataURL: async () => 'data:image/png;base64,stub',
}));

import {
  auditLog,
  cacheControlFor,
  getWebRemoteState,
  listWebRemoteListeners,
  startWebRemoteServer,
  stopWebRemoteServer,
} from './server';

/** Tests bind on port 0, so read the ephemeral port back off the live server. */
function boundPort(): number {
  const listener = listWebRemoteListeners()[0];
  return (listener.server.address() as AddressInfo).port;
}

let port = 0;

interface TestResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  setCookie: string | undefined;
  json(): unknown;
}

/**
 * Raw http.request rather than fetch: fetch refuses to let a caller override
 * the Host header, which is exactly what the rebinding tests need to do.
 */
function request(
  path: string,
  init: { method?: string; headers?: Record<string, string>; host?: string; body?: string } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: {
          ...(init.headers ?? {}),
          ...(init.host ? { Host: init.host } : {}),
        },
        // Node otherwise rewrites an explicitly supplied Host header.
        setHost: init.host === undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const setCookie = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
            setCookie: Array.isArray(setCookie) ? setCookie[0] : setCookie,
            json: () => JSON.parse(body),
          });
        });
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

beforeEach(async () => {
  attachmentPath = null;
  config.webRemotePort = 0;
  config.webRemoteBindSelections = [{ kind: 'address', address: '127.0.0.1' }];
  await startWebRemoteServer();
  port = boundPort();
});

afterEach(async () => {
  await stopWebRemoteServer();
});

describe('web remote server', () => {
  describe('authentication', () => {
    it('rejects an API request with no token', async () => {
      const res = await request('/api/health');
      expect(res.status).toBe(401);
    });

    it('rejects an API request with a wrong token', async () => {
      const res = await request('/api/health', { headers: { Authorization: 'Bearer nope' } });
      expect(res.status).toBe(401);
    });

    it('accepts a bearer token', async () => {
      const res = await request('/api/health', { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ ok: true, result: { running: true } });
    });

    it('accepts a query-string token', async () => {
      const res = await request(`/api/health?token=${TOKEN}`);
      expect(res.status).toBe(200);
    });
  });

  describe('host allowlist', () => {
    it('allows a bound address', async () => {
      const res = await request(`/api/health?token=${TOKEN}`, { host: `127.0.0.1:${port}` });
      expect(res.status).toBe(200);
    });

    it('allows localhost', async () => {
      const res = await request(`/api/health?token=${TOKEN}`, { host: `localhost:${port}` });
      expect(res.status).toBe(200);
    });

    it('rejects an arbitrary rebinding host, and does so before auth', async () => {
      const res = await request('/api/health', { host: 'evil.example.com' });
      expect(res.status).toBe(403);
    });

    it('rejects an unbound address, with no vendor-specific bypass', async () => {
      const res = await request(`/api/health?token=${TOKEN}`, { host: 'whim.example.ts.net' });
      expect(res.status).toBe(403);
    });
  });

  describe('/api/invoke', () => {
    it('rejects a non-object body', async () => {
      const res = await request('/api/invoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([1, 2, 3]),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a missing channel', async () => {
      const res = await request('/api/invoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      });
      expect(res.status).toBe(400);
    });

    it('dispatches an allowed channel to the gateway', async () => {
      const res = await request('/api/invoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'spaces:list', args: [] }),
      });
      expect(res.status).toBe(200);
      expect(res.json()).toEqual({ ok: true, result: { echoed: 'spaces:list' } });
    });

    it('404s an unknown API path', async () => {
      const res = await request(`/api/nope?token=${TOKEN}`);
      expect(res.status).toBe(404);
    });
  });

  describe('static files', () => {
    // Serve the real build output rather than the sources; see
    // webRootDirectory() for why they differ under vitest.
    beforeEach(() => {
      process.env.WHIM_WEB_ROOT = path.join(__dirname, '..', '..', '..', 'dist', 'web');
    });
    afterEach(() => {
      delete process.env.WHIM_WEB_ROOT;
    });

    it('rejects a path traversal attempt', async () => {
      const res = await request('/..%2f..%2f..%2fetc%2fpasswd');
      expect(res.status).toBe(403);
    });

    it('rejects a non-GET method', async () => {
      const res = await request('/', { method: 'DELETE' });
      expect(res.status).toBe(405);
    });

    it('does not require a token for static files', async () => {
      const res = await request('/definitely-missing.js');
      expect(res.status).toBe(404);
    });

    /**
     * /desktop serves the real renderer. These assert the wiring the browser
     * depends on, which unit tests of the transport cannot reach: that the
     * route resolves at all, that the bundle is reachable at the absolute URL
     * boot.js injects, and that app.js is *not* referenced from the HTML —
     * if it were, it would evaluate before window.whimAPI existed and the
     * page would break in a way no test here would otherwise notice.
     */
    it('serves the desktop interface at /desktop', async () => {
      const res = await request('/desktop/');
      expect(res.status).toBe(200);
      expect(res.body).toContain('<script src="/desktop/boot.js"');
      expect(res.body).not.toContain('src="/desktop/app.js"');
    });

    it('serves the renderer bundle boot.js asks for', async () => {
      const res = await request('/desktop/app.js');
      expect(res.status).toBe(200);
    });

    it('resolves /desktop without a trailing slash', async () => {
      const res = await request('/desktop');
      expect(res.status).toBe(200);
    });
  });

  describe('sessions', () => {
    it('exchanges the bootstrap token for an HttpOnly session cookie', async () => {
      const res = await request('/api/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(200);
      expect(res.setCookie).toBeDefined();
      expect(res.setCookie).toContain('HttpOnly');
      expect(res.setCookie).toContain('SameSite=Strict');
      // Plain HTTP on loopback: a Secure cookie would simply be discarded.
      expect(res.setCookie).not.toContain('Secure');
    });

    it('authenticates subsequent requests with only the cookie', async () => {
      const issued = await request('/api/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const cookie = (issued.setCookie ?? '').split(';')[0];

      const res = await request('/api/health', { headers: { Cookie: cookie } });
      expect(res.status).toBe(200);
    });

    it('rejects a forged cookie', async () => {
      const res = await request('/api/health', { headers: { Cookie: 'whim_session=abc.forged' } });
      expect(res.status).toBe(401);
    });

    it('signing out revokes the device', async () => {
      const issued = await request('/api/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      const cookie = (issued.setCookie ?? '').split(';')[0];

      const signOut = await request('/api/session', { method: 'DELETE', headers: { Cookie: cookie } });
      expect(signOut.status).toBe(200);
      expect(signOut.setCookie).toContain('Max-Age=0');

      const after = await request('/api/health', { headers: { Cookie: cookie } });
      expect(after.status).toBe(401);
    });
  });

  describe('security headers', () => {
    it('sends no-referrer so the bootstrap URL cannot leak to linked-out sites', async () => {
      const res = await request(`/api/health?token=${TOKEN}`);
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('does not claim HSTS while serving plain HTTP', async () => {
      const res = await request(`/api/health?token=${TOKEN}`);
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });
  });

  describe('static caching', () => {
    // Served from src/web in tests, which is where __dirname/../../web resolves.
    it('revalidates index.html so a new bundle is always picked up', async () => {
      const res = await request('/index.html');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    it('caches content-hashed assets indefinitely and revalidates everything else', () => {
      expect(cacheControlFor('/dist/web/app.abcdef123456.js')).toBe('public, max-age=31536000, immutable');
      expect(cacheControlFor('/dist/web/styles.abcdef123456.css')).toBe('public, max-age=31536000, immutable');
      expect(cacheControlFor('/dist/web/app.js')).toBe('no-cache');
      expect(cacheControlFor('/dist/web/index.html')).toBe('no-cache');
    });

    it('answers a conditional request with 304', async () => {
      const first = await request('/index.html');
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();

      const second = await request('/index.html', { headers: { 'If-None-Match': etag } });
      expect(second.status).toBe(304);
      expect(second.body).toBe('');
    });

    it('compresses text assets when the client accepts it', async () => {
      const res = await request('/index.html', { headers: { 'Accept-Encoding': 'gzip' } });
      expect(res.headers['content-encoding']).toBe('gzip');
      expect(res.headers.vary).toBe('Accept-Encoding');
    });

    it('sends identity when the client does not accept compression', async () => {
      const res = await request('/index.html', { headers: { 'Accept-Encoding': 'identity' } });
      expect(res.headers['content-encoding']).toBeUndefined();
    });
  });

  describe('state reporting', () => {
    it('stays on plain HTTP for a loopback-only bind, since localhost is already a secure context', async () => {
      const state = await getWebRemoteState();
      expect(state.tls.mode).toBe('auto');
      expect(state.tls.active).toBe(false);
      expect(state.urls.every((url) => url.startsWith('http://'))).toBe(true);
    });

    it('reports running only when every selection is listening', async () => {
      const state = await getWebRemoteState();
      expect(state.running).toBe(true);
      expect(state.bindings).toHaveLength(1);
      expect(state.bindings[0].state).toBe('listening');
    });

    it('reports a selection whose interface is down as pending, not running', async () => {
      await stopWebRemoteServer();
      config.webRemoteBindSelections = [
        { kind: 'address', address: '127.0.0.1' },
        { kind: 'interface', interfaceName: 'utun-does-not-exist', family: 'IPv4' } as never,
      ];
      await startWebRemoteServer();
      port = boundPort();

      const state = await getWebRemoteState();
      expect(state.running).toBe(false);
      expect(state.bindings.map((binding) => binding.state)).toEqual(['listening', 'pending']);
    });
  });
  describe('audit log', () => {
    it('records the invoked channel, not the raw URL', async () => {
      await request('/api/invoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'space:list', args: [] }),
      });
      const latest = auditLog.recent(1)[0];
      expect(latest).toMatchObject({ channel: 'space:list', status: 200, outcome: 'ok', identity: 'token' });
    });

    it('never records a query string, which is where a token would be', async () => {
      await request(`/api/health?token=${TOKEN}`);
      expect(auditLog.recent(1)[0].path).toBe('/api/health');
    });

    it('marks a rejected request as denied', async () => {
      await request('/api/health');
      expect(auditLog.recent(1)[0]).toMatchObject({ status: 401, outcome: 'denied' });
    });
  });

  describe('rate limiting', () => {
    it('rejects a caller that floods /api/invoke and tells it when to retry', async () => {
      const send = () => request('/api/invoke', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: 'space:list', args: [] }),
      });

      let limited: Awaited<ReturnType<typeof send>> | null = null;
      for (let i = 0; i < 80 && !limited; i += 1) {
        const res = await send();
        if (res.status === 429) limited = res;
      }

      expect(limited).not.toBeNull();
      expect(limited!.headers['retry-after']).toBeDefined();
      expect((limited!.json() as { error: { code: string } }).error.code).toBe('rate_limited');
    });
  });

  describe('cache policy', () => {
    it('caches content-hashed bundles forever', () => {
      expect(cacheControlFor('/dist/web/app.d4eb09cff260.js')).toBe('public, max-age=31536000, immutable');
    });

    it('never caches the service worker', () => {
      expect(cacheControlFor('/dist/web/sw.js')).toBe('no-cache');
    });

    it('revalidates index.html so a new bundle is picked up', () => {
      expect(cacheControlFor('/dist/web/index.html')).toBe('no-cache');
    });
  });

  describe('attachment route', () => {
    it('requires spaceId and path', async () => {
      const res = await request('/api/attachment', { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(res.status).toBe(400);
    });

    it('requires authentication', async () => {
      const res = await request('/api/attachment?spaceId=sp1&path=a.png');
      expect(res.status).toBe(401);
    });

    it('404s when the attachment escapes or is missing', async () => {
      attachmentPath = null;
      const res = await request('/api/attachment?spaceId=sp1&path=../../etc/passwd', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    });

    it('404s for an unknown space', async () => {
      const res = await request('/api/attachment?spaceId=nope&path=a.png', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    });

    it('serves the file with a private cache policy', async () => {
      const file = path.join(os.tmpdir(), `whim-attachment-${Date.now()}.png`);
      fs.writeFileSync(file, 'pixels');
      attachmentPath = file;
      try {
        const res = await request('/api/attachment?spaceId=sp1&path=a.png', {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/png');
        expect(res.headers['cache-control']).toBe('private, max-age=3600');
        expect(res.body).toBe('pixels');
      } finally {
        fs.unlinkSync(file);
      }
    });
  });
});
