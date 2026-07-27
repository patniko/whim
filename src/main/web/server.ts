import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import type { Duplex } from 'stream';
import { app } from 'electron';
import * as QRCode from 'qrcode';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  WebRemoteBindingStatus,
  WebRemoteBindSelection,
  WebRemoteState,
  WebRemoteTlsState,
} from '../../shared/ipc-contract';
import {
  ensureWebRemoteToken,
  getConfig,
  getConfigValue,
  normalizeWebRemotePort,
  setConfigValue,
} from '../config';
import {
  extractWebSocketProtocolToken,
  getRemoteAddress,
  WebRemoteAuthenticator,
} from './auth';
import { WebRemoteBinder, type BoundListener } from './binder';
import { createHostPolicy, type HostPolicy } from './hosts';
import { listWebRemoteInterfaces, normalizeBindSelections, resolveBindSelections } from './interfaces';
import { resolveTls, type TlsMaterial } from './tls';
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  DeviceSessionStore,
  type WebRemoteDeviceRecord,
} from './sessions';
import { GatewayError, invokeWebRemoteCommand } from './gateway';
import { subscribeWebRemoteEvents } from './event-hub';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const MAX_BODY_BYTES = 1_000_000;

/**
 * Slowloris / half-open socket protection. Without these a stalled client can
 * hold a connection open indefinitely.
 */
const HEADERS_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;

const clients = new Set<WebSocket>();
let lastError: string | null = null;
let tlsMaterial: TlsMaterial | null = null;
let tlsState: WebRemoteTlsState = {
  mode: 'auto', active: false, fingerprint: null, expiresAt: null, error: null,
};
let hostPolicy: HostPolicy = createHostPolicy({ boundAddresses: [], allowedHosts: [] });

export const sessionStore = new DeviceSessionStore({
  load: () => (getConfigValue('webRemoteDevices') as WebRemoteDeviceRecord[] | undefined) ?? [],
  save: (records) => setConfigValue('webRemoteDevices', records),
});

const authenticator = new WebRemoteAuthenticator(() => getConfigValue('webRemoteToken'), sessionStore);

const binder = new WebRemoteBinder({
  listen: (address, port) => startListener(address, port),
  onChange: () => {
    // The Host allowlist is derived from what we are actually listening on, so
    // it has to be rebuilt whenever the set of bindings changes.
    updateHostPolicy();
    const failed = binder.status().filter((entry) => entry.state === 'failed');
    lastError = failed.length > 0
      ? failed.map((entry) => `${entry.label}: ${entry.detail}`).join('; ')
      : null;
  },
});

export async function syncWebRemoteServer(): Promise<WebRemoteState> {
  if (getConfigValue('webRemoteEnabled')) {
    try {
      await startWebRemoteServer();
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.warn('[web-remote] Failed to start:', lastError);
      await stopWebRemoteServer();
    }
  } else {
    await stopWebRemoteServer();
  }
  return getWebRemoteState();
}

export async function restartWebRemoteServer(): Promise<WebRemoteState> {
  await stopWebRemoteServer();
  return syncWebRemoteServer();
}

export async function startWebRemoteServer(): Promise<void> {
  const workspace = getConfigValue('workspace');
  if (!workspace) {
    throw new Error('Select a workspace before enabling web remote access.');
  }

  const token = ensureWebRemoteToken();
  if (!token) {
    throw new Error('Web remote token is not configured.');
  }

  const config = getConfig();
  const port = normalizeWebRemotePort(config.webRemotePort);
  const selections = normalizeBindSelections(config.webRemoteBindSelections);

  // TLS material has to exist before the first listener is created, since the
  // listener type (http vs https) depends on it.
  applyTls(selections);
  updateHostPolicy();

  lastError = null;
  if (binder.isActive()) {
    await binder.update(selections, port);
  } else {
    await binder.start(selections, port);
  }

  // Nothing bound at all is a hard failure. A *partially* bound state is not:
  // the remaining interfaces may simply not be up yet, and the binder will
  // attach to them as soon as they appear. That case is reported through
  // per-selection status rather than by refusing to run.
  if (binder.boundAddresses().length === 0) {
    const unbound = binder.status().filter((entry) => entry.state !== 'listening');
    throw new Error(
      unbound.length > 0
        ? unbound.map((entry) => `${entry.label}: ${entry.detail}`).join('; ')
        : 'No bind addresses are available.',
    );
  }
}

export async function stopWebRemoteServer(): Promise<void> {
  authenticator.reset();
  for (const client of clients) {
    client.terminate();
  }
  clients.clear();
  tlsMaterial = null;
  tlsState = { mode: getConfigValue('webRemoteTlsMode') ?? 'auto', active: false, fingerprint: null, expiresAt: null, error: null };
  await binder.stop();
  updateHostPolicy();
}

/** Live listeners, exposed for diagnostics and tests. */
export function listWebRemoteListeners(): BoundListener[] {
  return binder.listening();
}

/**
 * Force an immediate re-resolve of selections against the current network.
 * Called on wake from sleep, where interfaces routinely change while the
 * poll timer was suspended.
 */
export async function refreshWebRemoteBindings(): Promise<void> {
  await binder.refresh();
}

export async function getWebRemoteState(): Promise<WebRemoteState> {
  const config = getConfig();
  const token = ensureWebRemoteToken();
  const selections = normalizeBindSelections(config.webRemoteBindSelections);
  const bindings = binder.isActive() ? binder.status() : previewStatus(selections);

  const urls = buildRemoteUrls(bindings, config.webRemotePort, token);
  const qrUrl = urls.find((url) => !url.includes('127.0.0.1') && !url.includes('[::1]')) ?? urls[0] ?? null;

  let qrDataUrl: string | null = null;
  if (qrUrl) {
    try {
      qrDataUrl = await QRCode.toDataURL(qrUrl, { margin: 1, width: 192 });
    } catch (err) {
      console.warn('[web-remote] Failed to render QR code:', err);
    }
  }

  return {
    enabled: config.webRemoteEnabled,
    // Honest: partially-bound is not "running".
    running: binder.isActive() && binder.isFullyBound(),
    port: config.webRemotePort,
    token,
    selections,
    bindings,
    interfaces: listWebRemoteInterfaces(),
    urls,
    qrDataUrl,
    error: lastError,
    tls: tlsState,
    allowedHosts: config.webRemoteAllowedHosts,
    devices: sessionStore.list(),
  };
}

/** Status shown while the server is stopped: what *would* be bound. */
function previewStatus(selections: WebRemoteBindSelection[]): WebRemoteBindingStatus[] {
  return resolveBindSelections(selections).map((entry) => ({
    selection: entry.selection,
    label: entry.label,
    scope: entry.scope,
    state: 'pending' as const,
    addresses: entry.addresses,
    detail: entry.addresses.length > 0
      ? 'Not started.'
      : 'Interface is not currently available.',
  }));
}

function startListener(address: string, port: number): Promise<BoundListener> {
  const wss = new WebSocketServer({ noServer: true });
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    void handleHttp(req, res).catch((err) => {
      const status = err instanceof GatewayError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'Internal server error';
      sendJson(res, status, { ok: false, error: { code: 'request_failed', message } });
    });
  };

  const server = tlsMaterial
    ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, handler)
    : http.createServer(handler);

  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  server.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head, wss);
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', timestamp: new Date().toISOString() }));
    const unsubscribe = subscribeWebRemoteEvents((event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event', event }));
      }
    });
    const cleanup = () => {
      unsubscribe();
      clients.delete(ws);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      server.on('error', (err) => console.warn('[web-remote] Server error:', err));
      resolve({
        address,
        port,
        server,
        close: () => new Promise<void>((resolveClose) => {
          wss.close(() => {
            server.close(() => resolveClose());
          });
        }),
      });
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, address);
  });
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = requestUrl(req);
  if (!hostPolicy.allows(req.headers.host)) {
    sendJson(res, 403, { ok: false, error: { code: 'host_not_allowed', message: 'Host header is not allowed.' } });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    const auth = authenticator.authenticateRequest({ headers: req.headers, url, remoteAddress: getRemoteAddress(req) });
    if (!auth.ok) {
      sendJson(res, auth.status, { ok: false, error: { code: 'auth_failed', message: auth.message } });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/session') {
      // Exchange the bootstrap token for a per-device session cookie so the
      // token stops travelling in the URL (and therefore in history/Referer).
      const issued = sessionStore.issue(req.headers['user-agent'], getRemoteAddress(req));
      res.setHeader('Set-Cookie', buildSessionCookie(issued.cookieValue, { secure: tlsState.active }));
      sendJson(res, 200, { ok: true, result: { device: { id: issued.record.id, label: issued.record.label } } });
      return;
    }

    if (req.method === 'DELETE' && url.pathname === '/api/session') {
      if (auth.device) sessionStore.revoke(auth.device.id);
      res.setHeader('Set-Cookie', buildClearedSessionCookie());
      sendJson(res, 200, { ok: true, result: { signedOut: true } });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, result: { running: true } });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/invoke') {
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new GatewayError('invalid_body', 400, 'Request body must be an object.');
      }
      const payload = body as Record<string, unknown>;
      if (typeof payload.channel !== 'string') {
        throw new GatewayError('invalid_body', 400, 'channel must be a string.');
      }
      const result = await invokeWebRemoteCommand(payload.channel, Array.isArray(payload.args) ? payload.args : []);
      sendJson(res, 200, { ok: true, result });
      return;
    }

    sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'API endpoint not found.' } });
    return;
  }

  serveStatic(req, res, url);
}

async function handleUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
): Promise<void> {
  const url = requestUrl(req);
  if (url.pathname !== '/api/events' || !hostPolicy.allows(req.headers.host)) {
    socket.destroy();
    return;
  }

  // WebSocket upgrades are not subject to CORS, so without an explicit Origin
  // check any page the user visits could open an authenticated socket using
  // their session cookie.
  if (!isAllowedOrigin(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const protocolToken = extractWebSocketProtocolToken(req.headers['sec-websocket-protocol']);
  const auth = protocolToken
    ? authenticator.authenticate(protocolToken, getRemoteAddress(req))
    : authenticator.authenticateRequest({ headers: req.headers, url, remoteAddress: getRemoteAddress(req) });
  if (!auth.ok) {
    socket.write(`HTTP/1.1 ${auth.status} ${auth.message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new GatewayError('body_too_large', 413, 'Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new GatewayError('invalid_json', 400, 'Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, securityHeaders());
    res.end('Method not allowed');
    return;
  }

  const root = path.resolve(__dirname, '..', '..', 'web');
  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const resolved = path.resolve(root, relativePath);

  if (!resolved.startsWith(root + path.sep)) {
    res.writeHead(403, securityHeaders());
    res.end('Forbidden');
    return;
  }

  const filePath = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, 'index.html')
    : resolved;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, securityHeaders());
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Baseline hardening headers.
 *
 * `Referrer-Policy` matters most here: canvas content routinely links out, and
 * without it the bootstrap URL (which carries the token) would leak to every
 * site the user clicks through to.
 */
function securityHeaders(): Record<string, string> {
  return {
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(tlsState.active
      ? { 'Strict-Transport-Security': 'max-age=31536000' }
      : {}),
  };
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // The bundled app uses inline styles; scripts stay same-origin only.
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    ...securityHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function requestUrl(req: http.IncomingMessage): URL {
  return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
}

function buildRemoteUrls(bindings: WebRemoteBindingStatus[], port: number, token: string): string[] {
  const scheme = tlsState.active ? 'https' : 'http';
  const urls: string[] = [];
  for (const binding of bindings) {
    for (const address of binding.addresses) {
      if (address === '0.0.0.0' || address === '::') continue;
      const host = address.includes(':') ? `[${address}]` : address;
      urls.push(`${scheme}://${host}:${port}/?token=${encodeURIComponent(token)}`);
    }
  }
  return [...new Set(urls)];
}

/**
 * An Origin is acceptable when its host is one we would accept in a Host
 * header. Non-browser clients omit Origin entirely; those are allowed, since
 * the header only exists to protect *browsers* from cross-origin abuse.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  try {
    return hostPolicy.allows(new URL(origin).host);
  } catch {
    return false;
  }
}

function updateHostPolicy(): void {
  hostPolicy = createHostPolicy({
    boundAddresses: binder.boundAddresses(),
    allowedHosts: getConfigValue('webRemoteAllowedHosts') ?? [],
  });
}

/**
 * Resolve TLS material for the addresses these selections currently resolve
 * to. Loopback-only deployments stay on plain HTTP: `http://localhost` is
 * already a secure context, so a self-signed cert would add warnings for no
 * security gain.
 */
function applyTls(selections: WebRemoteBindSelection[]): void {
  const resolved = resolveBindSelections(selections);
  const addresses = resolved.flatMap((entry) => entry.addresses);
  const loopbackOnly = resolved.every((entry) => entry.scope === 'loopback');
  const config = getConfig();

  const result = resolveTls({
    mode: config.webRemoteTlsMode,
    certPath: config.webRemoteTlsCertPath,
    keyPath: config.webRemoteTlsKeyPath,
    addresses,
    extraHosts: config.webRemoteAllowedHosts,
    cachePath: path.join(app.getPath('userData'), 'web-remote-tls.json'),
    loopbackOnly,
  });

  tlsMaterial = result.material;
  tlsState = result.state;
}
