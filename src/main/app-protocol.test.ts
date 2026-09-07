import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { serveAppRequest } from './app-protocol';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'whim-protocol-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('module protocol', () => {
  it('sets response MIME for modules, workers and fonts (not request headers)', async () => {
    for (const [file, mime] of [['chunk.ABCDEFGH.js', 'application/javascript; charset=utf-8'], ['font.woff2', 'font/woff2']]) {
      writeFileSync(path.join(root, file), 'synthetic');
      const response = await serveAppRequest(new Request(`copilot-whim://app/renderer/${file}`), root, null,
        async () => new Response('synthetic', { headers: { 'Content-Type': 'text/plain' } }));
      expect(response.headers.get('Content-Type')).toBe(mime);
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    }
  });
  it('rejects foreign origins, escaped paths, and links outside the renderer', async () => {
    mkdirSync(path.join(root, 'renderer'));
    writeFileSync(path.join(root, 'outside.js'), 'synthetic');
    symlinkSync(path.join(root, 'outside.js'), path.join(root, 'renderer', 'linked.js'));
    const fetch = vi.fn();
    for (const url of [
      'copilot-whim://foreign/renderer/linked.js',
      'copilot-whim://app/renderer/linked.js',
      'copilot-whim://app/renderer/..%2foutside.js',
    ]) {
      const response = await serveAppRequest(new Request(url), path.join(root, 'renderer'), null, fetch);
      expect(response.status).toBe(403);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
