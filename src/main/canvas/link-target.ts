/**
 * What a link inside a canvas refers to — decided, not acted on.
 *
 * The handler behind `canvas:open-link` used to work out what a link meant
 * and open it in the same breath: a workspace `.md` file became a new canvas
 * window, anything else went to `shell.openExternal` or `shell.openPath`.
 * Every one of those effects is a desktop one, so the whole channel was
 * desktop-only and links in a document did nothing at all over the web
 * remote.
 *
 * The decision, though, is not desktop-specific — it is a question about the
 * workspace, and a browser needs the answer as much as the desktop does. So
 * the decision lives here, on its own, and each client applies it in the way
 * that makes sense where it is running: the desktop opens a window, the
 * browser navigates or opens a tab.
 *
 * Keeping it pure also makes the path rules testable without a filesystem or
 * an Electron shell, which is the part worth being sure about.
 */
import * as path from 'path';

export type LinkTarget =
  /** A URL for the host to open — http(s) or mailto. */
  | { kind: 'external'; url: string }
  /** A markdown file inside the workspace, which opens as a canvas. */
  | { kind: 'canvas'; filePath: string }
  /** A file on disk that is not a canvas; only a desktop host can open it. */
  | { kind: 'file'; filePath: string }
  /** Nothing actionable. */
  | { kind: 'none'; reason: 'no_workspace' | 'invalid_url' | 'unresolved' };

export interface LinkResolutionContext {
  /** Directory relative links resolve against, or null if the canvas has none. */
  baseDir: string | null;
  /** Whether a path is a markdown file inside the workspace. */
  isWorkspaceMdFile: (filePath: string) => boolean;
}

const EXTERNAL_PREFIXES = ['http://', 'https://', 'mailto:'];

/** Decide what a link in a canvas refers to, without opening anything. */
export function resolveLinkTarget(url: string, ctx: LinkResolutionContext): LinkTarget {
  // Strip fragment (#heading) and query string before filesystem checks
  const hashIdx = url.indexOf('#');
  const cleanUrl = hashIdx >= 0 ? url.slice(0, hashIdx) : url;

  // Checked before anything else because `mailto:` carries no `//`, so the
  // relative-path branch below used to claim it and hand back a path like
  // `<space>/mailto:someone@example.com` — which the desktop then dutifully
  // asked the OS to open, and nothing happened.
  if (EXTERNAL_PREFIXES.some((prefix) => cleanUrl.startsWith(prefix))) {
    // The original url, fragment intact: a heading anchor is part of where the
    // link points, and only the filesystem checks needed it gone.
    return { kind: 'external', url };
  }

  let filePath: string | null = null;

  if (cleanUrl.startsWith('file://')) {
    try {
      filePath = decodeURIComponent(new URL(cleanUrl).pathname);
    } catch {
      return { kind: 'none', reason: 'invalid_url' };
    }
  } else if (cleanUrl.startsWith('/')) {
    filePath = cleanUrl;
  } else if (!cleanUrl.includes('://')) {
    // Relative path — resolve against the current canvas context.
    if (ctx.baseDir) filePath = path.resolve(ctx.baseDir, decodeURIComponent(cleanUrl));
  }

  if (!filePath) return { kind: 'none', reason: 'unresolved' };

  filePath = decodeURIComponent(filePath);

  return ctx.isWorkspaceMdFile(filePath)
    ? { kind: 'canvas', filePath }
    : { kind: 'file', filePath };
}
