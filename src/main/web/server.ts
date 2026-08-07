import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as zlib from 'zlib';
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
  extractHttpToken,
  extractWebSocketProtocolToken,
  getRemoteAddress,
  WebRemoteAuthenticator,
} from './auth';
import { normalizeAddress, redactPath, WebRemoteAuditLog, WebRemoteRateLimiter } from './audit';
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
import { currentEventSequence, replayEventsSince, subscribeWebRemoteEvents } from './event-hub';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY_BYTES = 1_000_000;

/**
 * Slowloris / half-open socket protection. Without these a stalled client can
 * hold a connection open indefinitely.
 */
const HEADERS_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const WS_PING_INTERVAL_MS = 30_000;

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

const authenticator = new WebRemoteAuthenticator(
  () => getConfigValue('webRemoteToken'),
  sessionStore,
  (records) => setConfigValue('webRemoteLockouts', records),
);

export const auditLog = new WebRemoteAuditLog();
/**
 * Sized from what the interface actually does, not from a round number.
 *
 * A cold load spends roughly a dozen calls before it paints, a reload spends
 * them again immediately, and each open subagent view adds a timer — so the
 * burst allowance has to cover several page loads back to back or the app
 * rate-limits itself while behaving normally. The sustained ceiling is what
 * bounds a runaway loop or a hostile client, and 600/min is still an order of
 * magnitude below anything that could be used to hammer the host.
 */
const RATE_LIMIT_BURST = 240;
const RATE_LIMIT_PER_MINUTE = 600;
export const rateLimitPolicy = { burst: RATE_LIMIT_BURST, perMinute: RATE_LIMIT_PER_MINUTE };
const rateLimiter = new WebRemoteRateLimiter(RATE_LIMIT_BURST, 60_000, Date.now, RATE_LIMIT_PER_MINUTE);

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

  authenticator.hydrate(getConfigValue('webRemoteLockouts'));

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

  // Refuse to listen in the clear on anything routable. `applyTls` records the
  // reason; binding anyway would put the pairing token and the session cookie
  // on the wire in plaintext.
  if (!tlsState.active && tlsState.error) {
    throw new Error(tlsState.error);
  }

  updateHostPolicy();

  lastError = null;
  if (binder.isActive()) {
    await binder.update(selections, port);
  } else {
    await binder.start(selections, port);
  }

  // A *partially* bound state is not a failure: the remaining interfaces may
  // simply not be up yet, and the binder will attach to them as soon as they
  // appear. That case is reported through per-selection status rather than by
  // refusing to run.
  if (binder.boundAddresses().length === 0) {
    const unbound = binder.status().filter((entry) => entry.state !== 'listening');
    const detail = unbound.length > 0
      ? unbound.map((entry) => `${entry.label}: ${entry.detail}`).join('; ')
      : 'No bind addresses are available.';

    // Binding nothing *yet* is the whole case durable intent exists to serve.
    // Throwing here made `syncWebRemoteServer` stop the binder, which tore
    // down the polling that would have bound the interface once it appeared —
    // so selecting a disconnected VPN never recovered when it connected, which
    // is precisely the bug this design was meant to fix. Stay up and let
    // reconciliation do its job; the state is reported as an error either way.
    if (unbound.some((entry) => entry.state === 'pending')) {
      lastError = detail;
      return;
    }

    throw new Error(detail);
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
    activity: auditLog.recent(30),
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

  wss.on('connection', (ws, req: http.IncomingMessage) => {
    clients.add(ws);

    // Replay anything the client missed while it was disconnected. Mobile
    // browsers suspend sockets aggressively, and without this the UI silently
    // shows stale state after every backgrounding.
    const replay = replayEventsSince(Number(requestUrl(req).searchParams.get('lastSeq')));

    ws.send(JSON.stringify({
      type: 'hello',
      timestamp: new Date().toISOString(),
      seq: currentEventSequence(),
      resyncRequired: replay.kind === 'resync-required',
    }));

    if (replay.kind === 'events') {
      for (const event of replay.events) {
        ws.send(JSON.stringify({ type: 'event', event }));
      }
    }

    const unsubscribe = subscribeWebRemoteEvents((event) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'event', event }));
      }
    });

    // Liveness: a NAT or mobile radio can drop a connection without either
    // side seeing a FIN, leaving a half-open socket that looks "live" while
    // delivering nothing.
    let awaitingPong = false;
    const heartbeat = setInterval(() => {
      if (awaitingPong) {
        ws.terminate();
        return;
      }
      awaitingPong = true;
      ws.ping();
    }, WS_PING_INTERVAL_MS);
    heartbeat.unref?.();
    ws.on('pong', () => { awaitingPong = false; });

    const cleanup = () => {
      clearInterval(heartbeat);
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
  const startedAt = Date.now();
  let channel: string | null = null;
  let identity = 'anonymous';

  res.on('finish', () => {
    auditLog.record({
      at: startedAt,
      method: req.method ?? 'GET',
      path: redactPath(req.url ?? '/'),
      channel,
      status: res.statusCode,
      outcome: res.statusCode === 429 ? 'rate-limited'
        : res.statusCode === 401 || res.statusCode === 403 ? 'denied'
        : res.statusCode >= 400 ? 'error'
        : 'ok',
      identity,
      remoteAddress: normalizeAddress(getRemoteAddress(req)),
      durationMs: Date.now() - startedAt,
    });
  });

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
    identity = auth.device ? `${auth.device.label} (${auth.device.id.slice(0, 8)})` : 'token';

    if (req.method === 'POST' && url.pathname === '/api/session') {
      // Exchange the bootstrap token for a per-device session cookie so the
      // token stops travelling in the URL (and therefore in history/Referer).
      //
      // Only the bootstrap token may mint a session. Accepting an existing
      // cookie here let a stolen one clone itself into a second, separately
      // named device, so revoking the device you knew about left the attacker
      // holding a credential you never saw — which defeats the point of making
      // sessions individually revocable.
      //
      // That rule is about what the caller *presented*, which is why the token
      // is re-checked here rather than reusing the result above. The shared
      // authenticator prefers a session cookie when it finds one, so a browser
      // that was already paired and then opened the QR link again arrived with
      // both credentials and was reported as `via: 'session'` — and refused,
      // despite having supplied the very token pairing asks for. Re-pairing a
      // known device is a thing people do (a new token, a cookie they are not
      // sure about, a shared machine), and it failed with a 403 they could do
      // nothing about. Requiring the token directly keeps the property the
      // comment above describes: a stolen cookie on its own still cannot mint
      // a session, because with no valid token this call now fails outright.
      const presentedToken = extractHttpToken(req.headers, url);
      // No token at all is refused without being counted as a failed attempt:
      // the lockout exists to blunt token guessing, and a client that never
      // offered a token has not guessed at one. A *wrong* token below is a
      // different matter and is counted.
      const pairing = presentedToken
        ? authenticator.authenticate(presentedToken, getRemoteAddress(req))
        : null;
      if (!pairing?.ok) {
        sendJson(res, 403, {
          ok: false,
          error: { code: 'pairing_required', message: 'Pairing token required to create a session.' },
        });
        return;
      }
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

    if (req.method === 'GET' && url.pathname === '/api/attachment') {
      await serveAttachment(res, url);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/invoke') {
      // The session cookie is sent by the browser automatically, so the
      // request being authenticated says nothing about who *initiated* it.
      // SameSite=Strict stops another site, but not another origin on the same
      // site — a different port on this machine is same-site, and whim is
      // exactly the kind of thing that runs alongside other local services.
      // Requiring JSON also costs an attacker the simple-request exemption:
      // a cross-origin POST that avoids preflight cannot set this header.
      if (!isAllowedOrigin(req.headers.origin)) {
        sendJson(res, 403, {
          ok: false,
          error: { code: 'origin_not_allowed', message: 'Origin is not allowed.' },
        });
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        sendJson(res, 415, {
          ok: false,
          error: { code: 'unsupported_media_type', message: 'Content-Type must be application/json.' },
        });
        return;
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new GatewayError('invalid_body', 400, 'Request body must be an object.');
      }
      const payload = body as Record<string, unknown>;
      if (typeof payload.channel !== 'string') {
        throw new GatewayError('invalid_body', 400, 'channel must be a string.');
      }
      channel = payload.channel;

      // Failed logins are throttled by the authenticator, but every successful
      // invoke does real work — spawning agents, touching the filesystem — so
      // an authenticated caller needs a ceiling too.
      const limit = rateLimiter.check(identity);
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds));
        sendJson(res, 429, { ok: false, error: { code: 'rate_limited', message: 'Too many requests. Slow down.' } });
        return;
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

/**
 * Where the browser assets live.
 *
 * Resolved from the compiled server's own location, which lands on dist/web
 * in a real run. Under vitest the sources run in place, so `__dirname` is
 * src/main/web and this would resolve to src/web — a directory that contains
 * TypeScript rather than a built page. WHIM_WEB_ROOT lets a test point at the
 * actual build output so route wiring is verified against what ships.
 */
export function webRootDirectory(): string {
  return process.env.WHIM_WEB_ROOT
    ? path.resolve(process.env.WHIM_WEB_ROOT)
    : path.resolve(__dirname, '..', '..', 'web');
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, securityHeaders());
    res.end('Method not allowed');
    return;
  }

  const root = webRootDirectory();
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

  const stats = fs.statSync(filePath);
  const etag = `W/"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
  const headers: Record<string, string> = {
    ...securityHeaders(),
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': cacheControlFor(filePath),
    ETag: etag,
  };

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  // Text assets over a phone connection are worth compressing; images and
  // fonts are already compressed and would only burn CPU.
  const encoding = negotiateEncoding(req.headers['accept-encoding']);
  const compressible = /^(text\/|application\/(javascript|json|svg))/.test(headers['Content-Type']);

  if (encoding && compressible) {
    headers['Content-Encoding'] = encoding;
    headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers);
    const compressor = encoding === 'br' ? zlib.createBrotliCompress() : zlib.createGzip();
    fs.createReadStream(filePath).pipe(compressor).pipe(res);
    return;
  }

  headers['Content-Length'] = String(stats.size);
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Canvas markdown references attachments by a workspace-relative path
 * (`attachments/shot.png`). The desktop resolves those through
 * `canvas:resolve-attachment`, but the web server only ever served its own
 * bundle directory — so every image in every canvas 404'd in the browser.
 */
async function serveAttachment(res: http.ServerResponse, url: URL): Promise<void> {
  const spaceId = url.searchParams.get('spaceId');
  const relativePath = url.searchParams.get('path');
  if (!spaceId || !relativePath) {
    sendJson(res, 400, { ok: false, error: { code: 'invalid_request', message: 'spaceId and path are required.' } });
    return;
  }

  const workspace = getConfigValue('workspace');
  const { getSpace, isInitialized } = await import('../database');
  if (!workspace || !isInitialized()) {
    sendJson(res, 503, { ok: false, error: { code: 'no_workspace', message: 'No workspace is open.' } });
    return;
  }

  // Resolution is shared with `canvas:read-file`, so a page or a linked
  // workspace file addresses its images here exactly as it does on the
  // desktop. It carries the traversal check: any path that escapes the
  // canvas's own directory, or a `__file__` id pointing outside the
  // workspace, resolves to nothing.
  const { resolveCanvasFile } = await import('../canvas/canvas-file-root');
  const { getMimeType } = await import('../workspace');
  const absolute = resolveCanvasFile(
    workspace,
    spaceId,
    relativePath,
    (id) => getSpace(id)?.folder ?? null,
  );
  if (!absolute) {
    sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Attachment not found.' } });
    return;
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolute);
  } catch {
    // The file can vanish between the resolve above and this call. That is a
    // missing attachment, not a server fault, and it must not throw out of the
    // request handler.
    sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Attachment not found.' } });
    return;
  }

  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': getMimeType(absolute),
    'Content-Length': String(stats.size),
    // Attachments are immutable in practice but scoped to a session, so keep
    // them private to this browser rather than allowing shared caches.
    'Cache-Control': 'private, max-age=3600',
  });
  const stream = fs.createReadStream(absolute);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Content-hashed filenames (`app.<hash>.js`) can be cached indefinitely. */
const HASHED_ASSET_RE = /\.[0-9a-f]{12}\.(js|css)$/;

export function cacheControlFor(filePath: string): string {
  // A cached service worker would pin the app to an old shell indefinitely,
  // since the worker is what decides when to fetch a new one.
  if (path.basename(filePath) === 'sw.js') return 'no-cache';
  if (HASHED_ASSET_RE.test(filePath)) return 'public, max-age=31536000, immutable';
  // index.html must always be revalidated, or a client would never learn about
  // a new bundle. `no-cache` still permits a cheap 304.
  return 'no-cache';
}

function negotiateEncoding(header: string | undefined): 'br' | 'gzip' | null {
  if (!header) return null;
  const accepted = header.toLowerCase();
  if (accepted.includes('br')) return 'br';
  if (accepted.includes('gzip')) return 'gzip';
  return null;
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

/**
 * The path the shared URLs and QR code point at.
 *
 * `/desktop` serves whim's real interface; `/` serves the lightweight client.
 * The full interface is what people are actually asking for when they open the
 * app from another device, so it is what they get by default.
 */
const PRIMARY_PATH = '/desktop/';

function buildRemoteUrls(bindings: WebRemoteBindingStatus[], port: number, token: string): string[] {
  const scheme = tlsState.active ? 'https' : 'http';
  const urls: string[] = [];
  for (const binding of bindings) {
    for (const address of binding.addresses) {
      if (address === '0.0.0.0' || address === '::') continue;
      const host = address.includes(':') ? `[${address}]` : address;
      urls.push(`${scheme}://${host}:${port}${PRIMARY_PATH}?token=${encodeURIComponent(token)}`);
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
