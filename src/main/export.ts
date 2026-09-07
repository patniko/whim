/**
 * Canvas export engine.
 *
 * Turns a canvas (`canvas.md`, a child page, or a workspace `.md` file) into a
 * shareable file in one of three formats:
 *   - `md`   raw Markdown (frontmatter stripped)
 *   - `pdf`  rendered PDF (offscreen BrowserWindow → printToPDF)
 *   - `docx` Word document (Markdown → HTML → html-to-docx, images inlined)
 *
 * The engine is intentionally self-contained so sharing works regardless of
 * editor state — it always renders from the canonical on-disk content.
 */

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { marked } from 'marked';
import HTMLtoDOCX from 'html-to-docx';
import { getConfigValue } from './config';
import { isInitialized, getSpace } from './storage';
import { resolveSpaceFolder, getMimeType } from './workspace';
import { readCanvas, readPage } from './storage';
import { parseFrontmatter } from '../shared/frontmatter';
import type { ExportFormat } from '../shared/types';

export type { ExportFormat };

export const EXPORT_FORMATS: ExportFormat[] = ['pdf', 'docx', 'md'];

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  pdf: 'pdf',
  docx: 'docx',
  md: 'md',
};

export const EXPORT_LABELS: Record<ExportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word',
  md: 'Markdown',
};

export interface LoadedCanvas {
  title: string;
  /** Markdown content with whim frontmatter stripped. */
  body: string;
  /** Absolute directory used to resolve relative attachment paths. */
  baseDir: string;
}

/** Mirror of the page-id encoding used by canvas-handlers (kept local on purpose). */
function parseSyntheticPageId(spaceId: string): { realSpaceId: string; pageName: string } | null {
  if (!spaceId.startsWith('__page__')) return null;
  const rest = spaceId.slice('__page__'.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx <= 0) return null;
  try {
    return {
      realSpaceId: rest.slice(0, slashIdx),
      pageName: decodeURIComponent(rest.slice(slashIdx + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a canvas target (real space, child page, or workspace .md file) to
 * its title, frontmatter-stripped Markdown body, and attachment base directory.
 */
export async function loadCanvasForExport(spaceId: string): Promise<LoadedCanvas | { error: string }> {
  const workspace = getConfigValue('workspace');
  if (!workspace || !isInitialized()) return { error: 'no_workspace' };

  // Workspace .md file pseudo-space.
  if (spaceId.startsWith('__file__')) {
    const filePath = decodeURIComponent(spaceId.slice('__file__'.length));
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return {
        title: path.basename(filePath, path.extname(filePath)) || 'Untitled',
        body: parseFrontmatter(content).body,
        baseDir: path.dirname(filePath),
      };
    } catch {
      return { error: 'read_failed' };
    }
  }

  // Child page pseudo-space.
  const pageTarget = parseSyntheticPageId(spaceId);
  if (pageTarget) {
    const space = (await getSpace(pageTarget.realSpaceId));
    if (!space || !space.folder) return { error: 'not_found' };
    const result = (await readPage(workspace, space.folder, pageTarget.pageName));
    if ('error' in result) return { error: result.error };
    return {
      title: pageTarget.pageName.replace(/\.md$/i, '') || 'Untitled',
      body: parseFrontmatter(result.content).body,
      baseDir: resolveSpaceFolder(workspace, space.folder),
    };
  }

  // Real space canvas.
  const space = (await getSpace(spaceId));
  if (!space || !space.folder) return { error: 'not_found' };
  const content = (await readCanvas(workspace, space.folder));
  const title = (space.description || '').trim().split('\n')[0].trim() || 'Untitled';
  return {
    title,
    body: parseFrontmatter(content).body,
    baseDir: resolveSpaceFolder(workspace, space.folder),
  };
}

/** Produce a filesystem-safe slug from a canvas title. */
export function slugifyTitle(title: string): string {
  const slug = (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'canvas';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const IMG_SRC_RE = /(<img\b[^>]*?\ssrc\s*=\s*)(['"])(.*?)\2/gi;

/**
 * Replace `<img src>` references to local files with base64 data URIs so the
 * images survive conversion to formats that don't resolve relative/file URLs
 * (notably .docx).
 */
function inlineLocalImages(html: string, baseDir: string): string {
  return html.replace(IMG_SRC_RE, (match, prefix: string, quote: string, src: string) => {
    if (/^(https?:|data:)/i.test(src)) return match;

    let filePath: string;
    try {
      if (src.startsWith('file://')) {
        filePath = fileURLToPath(src);
      } else if (path.isAbsolute(src)) {
        filePath = src;
      } else {
        filePath = path.join(baseDir, decodeURIComponent(src));
      }
    } catch {
      return match;
    }

    try {
      const data = fs.readFileSync(filePath);
      const mime = getMimeType(filePath);
      const dataUri = `data:${mime};base64,${data.toString('base64')}`;
      return `${prefix}${quote}${dataUri}${quote}`;
    } catch {
      return match;
    }
  });
}

const PRINT_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 12pt;
    line-height: 1.6;
    color: #1a1a1a;
  }
  .whim-export { max-width: 720px; margin: 0 auto; padding: 32px; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; font-weight: 600; }
  h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
  p { margin: 0.6em 0; }
  a { color: #2563eb; text-decoration: none; }
  ul, ol { padding-left: 1.5em; margin: 0.6em 0; }
  li { margin: 0.2em 0; }
  blockquote {
    margin: 0.8em 0; padding: 0.2em 1em;
    border-left: 3px solid #d1d5db; color: #4b5563;
  }
  code {
    font-family: "SF Mono", "Cascadia Code", Consolas, monospace;
    font-size: 0.9em; background: #f3f4f6;
    padding: 0.15em 0.35em; border-radius: 4px;
  }
  pre {
    background: #f6f8fa; padding: 12px 14px; border-radius: 8px;
    overflow-x: auto; line-height: 1.45;
  }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
  th, td { border: 1px solid #d1d5db; padding: 6px 10px; text-align: left; }
  th { background: #f3f4f6; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.5em 0; }
`;

/**
 * Render a loaded canvas to a complete standalone HTML document.
 * When `inlineImages` is set, local images are embedded as data URIs; otherwise
 * a `<base href>` pointing at the attachment folder lets a file:// renderer
 * resolve relative image paths.
 */
export function renderCanvasHtml(loaded: LoadedCanvas, opts: { inlineImages?: boolean } = {}): string {
  let inner = marked.parse(loaded.body, { async: false }) as string;
  let baseTag = '';
  if (opts.inlineImages) {
    inner = inlineLocalImages(inner, loaded.baseDir);
  } else {
    baseTag = `<base href="${pathToFileURL(loaded.baseDir + path.sep).href}">`;
  }

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${baseTag}
<title>${escapeHtml(loaded.title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body><article class="whim-export">${inner}</article></body>
</html>`;
}

async function htmlToPdfBuffer(html: string): Promise<Buffer> {
  const tmpHtml = path.join(
    os.tmpdir(),
    `whim-export-${Date.now()}-${Math.random().toString(36).slice(2)}.html`,
  );
  fs.writeFileSync(tmpHtml, html, 'utf-8');

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      // Local, transient render of our own content — allow file:// images
      // referenced via <base href> to load.
      webSecurity: false,
      offscreen: false,
    },
  });

  try {
    await win.loadFile(tmpHtml);
    // Give layout + images a brief moment to settle before snapshotting.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    return Buffer.from(pdf);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try {
      fs.unlinkSync(tmpHtml);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

async function htmlToDocxBuffer(html: string, title: string): Promise<Buffer> {
  const result = await HTMLtoDOCX(html, null, {
    title,
    footer: false,
    table: { row: { cantSplit: true } },
  });
  if (Buffer.isBuffer(result)) return result;
  if (result instanceof ArrayBuffer) return Buffer.from(result);
  // Blob path (browser only) — not expected in the main process.
  return Buffer.from(await (result as Blob).arrayBuffer());
}

/**
 * Build an export file for a canvas in the requested format.
 *
 * @param destDir Optional output directory. When omitted the file is written
 *                to a temp folder (used for OS share). When provided (an export
 *                destination), the file lands there for cloud sync / quick open.
 */
export async function buildExport(
  spaceId: string,
  format: ExportFormat,
  destDir?: string,
): Promise<{ path: string } | { error: string }> {
  if (!EXPORT_FORMATS.includes(format)) return { error: 'unsupported_format' };

  const loaded = (await loadCanvasForExport(spaceId));
  if ('error' in loaded) return loaded;

  const outDir = destDir || path.join(os.tmpdir(), 'whim-share');
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (err: any) {
    return { error: err?.message || 'mkdir_failed' };
  }

  const outPath = path.join(outDir, `${slugifyTitle(loaded.title)}.${EXPORT_EXTENSIONS[format]}`);

  try {
    if (format === 'md') {
      fs.writeFileSync(outPath, loaded.body, 'utf-8');
    } else if (format === 'pdf') {
      const buf = await htmlToPdfBuffer(renderCanvasHtml(loaded));
      fs.writeFileSync(outPath, buf);
    } else {
      const buf = await htmlToDocxBuffer(renderCanvasHtml(loaded, { inlineImages: true }), loaded.title);
      fs.writeFileSync(outPath, buf);
    }
    return { path: outPath };
  } catch (err: any) {
    return { error: err?.message || 'export_failed' };
  }
}
