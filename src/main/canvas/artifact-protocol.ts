/**
 * `whim-artifact://` protocol — serves canvas artifacts to a hardened window.
 *
 * Canvas artifacts are agent-authored HTML and are therefore untrusted. They
 * get their own scheme, and therefore their own origin, so they can never touch
 * the `copilot-whim://app` renderer origin, its storage, or any token. They are
 * also deliberately *not* served over whim's local HTTP server: that server's
 * token also authorizes `/api/invoke`, and a URL-embedded token is readable
 * from `location.href` by anything running in the page.
 *
 * URL shape:
 *   whim-artifact://space/<spaceId>/<artifactId>/<file>
 *
 * The core is pure and synchronous so it can be unit tested without Electron.
 */
import * as fs from 'fs';
import * as path from 'path';
import { protocol, session } from 'electron';
import { getArtifact, isValidArtifactId, resolveArtifactDir } from './artifact-store';

export const ARTIFACT_SCHEME = 'whim-artifact';
/** In-memory session partition: artifacts get no persistent storage of any kind. */
export const ARTIFACT_PARTITION = 'whim-artifact';
export const ARTIFACT_HOST = 'space';

/**
 * No `script-src` directive is emitted, so `default-src 'none'` blocks all
 * script execution. v1 artifacts are static HTML + CSS; making them interactive
 * would need a reviewed CSP and an explicit message channel.
 */
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export interface ParsedArtifactUrl {
  spaceId: string;
  artifactId: string;
  /** Path within the artifact directory; defaults to index.html. */
  file: string;
}

/** Where a space's files live. Injected so this module never imports the DB. */
export interface SpaceLocation {
  workspaceRoot: string;
  folder: string;
}

export type SpaceResolver = (spaceId: string) => SpaceLocation | null;

/** Build the URL that renders an artifact. */
export function buildArtifactUrl(spaceId: string, artifactId: string, file = 'index.html'): string {
  return `${ARTIFACT_SCHEME}://${ARTIFACT_HOST}/${encodeURIComponent(spaceId)}/${encodeURIComponent(artifactId)}/${file}`;
}

/**
 * Parse an artifact URL. Returns null for anything malformed — including a
 * mismatched host, so a future second host cannot be reached by accident.
 */
export function parseArtifactUrl(rawUrl: string): ParsedArtifactUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  if (url.protocol !== `${ARTIFACT_SCHEME}:`) return null;
  if (url.hostname !== ARTIFACT_HOST) return null;

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map(s => decodeURIComponent(s));

  if (segments.length < 2) return null;

  const [spaceId, artifactId, ...rest] = segments;
  if (!spaceId || !isValidArtifactId(artifactId)) return null;

  const file = rest.length > 0 ? rest.join('/') : 'index.html';
  // Segments are decoded after splitting, so a percent-encoded separator or
  // `..` only becomes visible here. Reject any traversal component outright.
  const components = file.split(/[\\/]+/);
  if (components.some(c => c === '' || c === '.' || c === '..' || c.includes('\0'))) return null;

  return { spaceId, artifactId, file };
}

export type ArtifactRequestResult =
  | { ok: true; filePath: string; mimeType: string; headers: Record<string, string> }
  | { ok: false; status: number; reason: string };

/**
 * Resolve a request to a concrete file inside the artifact directory.
 *
 * Containment is enforced with realpath, so a symlink planted inside the
 * artifact folder cannot be used to read arbitrary files.
 */
export function resolveArtifactRequest(rawUrl: string, resolveSpace: SpaceResolver): ArtifactRequestResult {
  const parsed = parseArtifactUrl(rawUrl);
  if (!parsed) return { ok: false, status: 400, reason: 'bad_url' };

  const location = resolveSpace(parsed.spaceId);
  if (!location) return { ok: false, status: 404, reason: 'unknown_space' };

  // The artifact must exist as a real, manifest-backed artifact.
  const artifact = getArtifact(location.workspaceRoot, location.folder, parsed.artifactId);
  if (!artifact) return { ok: false, status: 404, reason: 'unknown_artifact' };

  let artifactDir: string;
  try {
    artifactDir = resolveArtifactDir(location.workspaceRoot, location.folder, parsed.artifactId);
  } catch {
    return { ok: false, status: 400, reason: 'bad_artifact_id' };
  }

  const candidate = path.resolve(artifactDir, parsed.file);
  const realDir = realpathOrNull(artifactDir);
  const realCandidate = realpathOrNull(candidate);
  if (!realDir || !realCandidate) return { ok: false, status: 404, reason: 'not_found' };

  const relative = path.relative(realDir, realCandidate);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, status: 403, reason: 'escape' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realCandidate);
  } catch {
    return { ok: false, status: 404, reason: 'not_found' };
  }
  if (!stat.isFile()) return { ok: false, status: 404, reason: 'not_a_file' };

  const ext = path.extname(realCandidate).toLowerCase();
  const mimeType = MIME_TYPES[ext];
  if (!mimeType) return { ok: false, status: 415, reason: 'unsupported_type' };

  return {
    ok: true,
    filePath: realCandidate,
    mimeType,
    headers: {
      'Content-Type': mimeType,
      'Content-Security-Policy': ARTIFACT_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    },
  };
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// ── Electron wiring ──────────────────────────────────────

/**
 * Scheme privileges for the artifact origin.
 *
 * `standard` gives it a real origin so CSP and same-origin rules apply.
 * Everything else stays off: artifacts get no fetch API, no CORS, and are not
 * marked secure, so no powerful web API is reachable from a canvas.
 */
export const ARTIFACT_SCHEME_PRIVILEGES = {
  scheme: ARTIFACT_SCHEME,
  privileges: {
    standard: true,
    secure: false,
    supportFetchAPI: false,
    corsEnabled: false,
    allowServiceWorkers: false,
    stream: false,
  },
} as const;

/** Register privileges for the artifact scheme. Must run before `app.whenReady()`. */
export function registerArtifactSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([ARTIFACT_SCHEME_PRIVILEGES]);
}

/** The isolated, in-memory session artifact windows render in. */
export function getArtifactSession(): Electron.Session {
  return session.fromPartition(ARTIFACT_PARTITION);
}

let handlerRegistered = false;

/**
 * Remove `<meta http-equiv="refresh">` from an artifact before serving it.
 *
 * The CSP already stops scripts, which leaves meta refresh as the one way an
 * agent-authored page can navigate itself with no user involved — and the
 * window's navigation handler turns an outbound navigation into "open this in
 * the user's browser". Reports are meant to be inert until clicked.
 */
export function stripMetaRefresh(html: string): string {
  return html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*(?:"\s*refresh\s*"|'\s*refresh\s*'|refresh)[^>]*>/gi,
    '<!-- inert -->',
  );
}

/**
 * Install the artifact handler on the isolated session. Registered on that
 * session only, so the app's own renderer can never fetch artifact URLs.
 */
export function registerArtifactProtocol(resolveSpace: SpaceResolver): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  getArtifactSession().protocol.handle(ARTIFACT_SCHEME, request => {
    const result = resolveArtifactRequest(request.url, resolveSpace);
    if (!result.ok) {
      return new Response(result.reason, {
        status: result.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    try {
      const body = fs.readFileSync(result.filePath);
      const served = result.mimeType.startsWith('text/html')
        ? stripMetaRefresh(body.toString('utf-8'))
        : body;
      return new Response(served, { status: 200, headers: result.headers });
    } catch {
      return new Response('not_found', { status: 404 });
    }
  });
}

/** Test seam: forget that the handler was installed. */
export function resetArtifactProtocolForTests(): void {
  handlerRegistered = false;
}
