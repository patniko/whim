import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';

const TOKEN = 'test-token-0123456789';

const config = {
  webRemoteEnabled: true,
  webRemotePort: 0,
  webRemoteToken: TOKEN,
  webRemoteBindSelections: [{ kind: 'address', address: '127.0.0.1' }],
  workspace: '/tmp/workspace',
};

vi.mock('../config', () => ({
  getConfig: () => config,
  getConfigValue: (key: string) => (config as Record<string, unknown>)[key],
  ensureWebRemoteToken: () => config.webRemoteToken,
  normalizeWebRemotePort: (value: unknown) => Number(value) || 0,
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

vi.mock('qrcode', () => ({
  toDataURL: async () => 'data:image/png;base64,stub',
}));

import {
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
          resolve({
            status: res.statusCode ?? 0,
            body,
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
  });

  describe('state reporting', () => {
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
});
