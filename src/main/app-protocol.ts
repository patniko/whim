import * as path from 'path';
import { realpath } from 'fs/promises';
import { pathToFileURL } from 'url';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mov': 'video/quicktime', '.pdf': 'application/pdf',
};

export async function serveAppRequest(
  request: Request, rendererRoot: string, workspace: string | null,
  fetchFile: (url: string) => Promise<Response>,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== 'app' || url.port || !['GET', 'HEAD'].includes(request.method)) {
    return new Response('Forbidden', { status: 403 });
  }
  const isRenderer = url.pathname.startsWith('/renderer/');
  const root = isRenderer ? rendererRoot : url.pathname.startsWith('/workspace/') ? workspace : null;
  if (!root) return new Response('Not found', { status: 404 });
  let relative: string;
  try { relative = decodeURIComponent(url.pathname.slice(isRenderer ? 10 : 11)); }
  catch { return new Response('Invalid path', { status: 400 }); }
  try {
    const resolvedRoot = await realpath(root);
    const file = await realpath(path.resolve(root, relative));
    const within = path.relative(resolvedRoot, file);
    if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
      return new Response('Forbidden', { status: 403 });
    }
    const response = await fetchFile(pathToFileURL(file).href);
    const headers = new Headers(response.headers);
    headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Response('Not found', { status: 404 });
    throw error;
  }
}
