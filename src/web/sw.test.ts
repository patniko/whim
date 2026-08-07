import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

/**
 * The service worker is plain JS shipped verbatim to the browser, so these
 * tests evaluate the real file in a sandbox with a hand-rolled `self` rather
 * than testing a copy of its logic.
 *
 * What they are really guarding is one rule: nothing may be answered from
 * cache unless it is content-hashed. The desktop remote is served from stable,
 * unhashed URLs, and when the fetch handler cached those a browser could hold
 * a stale renderer forever — the page rendered briefly, then blanked, and no
 * rebuild could dislodge it.
 */

const SHELL = ['/index.html', '/app.abc123def456.js', '/styles.deadbeef0000.css', '/manifest.webmanifest'];

interface Listeners { [event: string]: (event: unknown) => void }

function loadServiceWorker() {
  const source = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf-8');
  const listeners: Listeners = {};
  const cacheStore = new Map<string, Map<string, unknown>>();
  const deleted: string[] = [];

  const caches = {
    open: async (name: string) => {
      if (!cacheStore.has(name)) cacheStore.set(name, new Map());
      const entries = cacheStore.get(name)!;
      return {
        // The real Cache API normalises request keys to absolute URLs.
        addAll: async (urls: string[]) => { for (const u of urls) entries.set(new URL(u, 'https://host').href, { cached: true }); },
        put: async (req: { url: string }, res: unknown) => { entries.set(req.url, res); },
        keys: async () => [...entries.keys()].map((url) => ({ url })),
      };
    },
    keys: async () => [...cacheStore.keys()],
    delete: async (name: string) => { deleted.push(name); cacheStore.delete(name); return true; },
    match: async (req: { url?: string } | string) => {
      const url = typeof req === 'string' ? req : req.url!;
      for (const entries of cacheStore.values()) if (entries.has(url)) return entries.get(url);
      return undefined;
    },
  };

  const fetched: string[] = [];
  const self = {
    __WHIM_SHELL__: SHELL,
    __WHIM_BUILD__: 'testbuild0001',
    location: { origin: 'https://host' },
    addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn; },
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
    caches,
    fetch: async (req: { url: string }) => {
      fetched.push(typeof req === 'string' ? req : req.url);
      return { ok: true, type: 'basic', clone: () => ({ body: 'network' }), body: 'network' };
    },
  };

  const context = vm.createContext({ self, caches, fetch: self.fetch, URL, Response: { error: () => ({ error: true }) }, Promise, console });
  vm.runInContext(source, context);
  return { listeners, cacheStore, deleted, fetched, self };
}

/** Drive the fetch handler and report whether it took over the request. */
async function handleFetch(sw: ReturnType<typeof loadServiceWorker>, url: string, mode = 'no-cors') {
  let responded: unknown = undefined;
  const event = {
    request: { url, method: 'GET', mode },
    respondWith: (value: unknown) => { responded = value; },
    waitUntil: (value: unknown) => value,
  };
  sw.listeners.fetch(event);
  return responded ? await responded : undefined;
}

describe('web remote service worker', () => {
  let sw: ReturnType<typeof loadServiceWorker>;

  beforeEach(() => { sw = loadServiceWorker(); });

  it('precaches exactly the declared shell on install', async () => {
    let work: unknown;
    sw.listeners.install({ waitUntil: (value: unknown) => { work = value; } });
    await work;
    const entries = sw.cacheStore.get('whim-shell-testbuild0001');
    expect([...entries!.keys()].sort()).toEqual(SHELL.map((p) => `https://host${p}`).sort());
  });

  it('drops caches from earlier builds on activate', async () => {
    sw.cacheStore.set('whim-shell-oldbuild9999', new Map());
    sw.cacheStore.set('whim-shell-testbuild0001', new Map());
    let work: unknown;
    sw.listeners.activate({ waitUntil: (value: unknown) => { work = value; } });
    await work;
    expect(sw.deleted).toEqual(['whim-shell-oldbuild9999']);
  });

  it('serves content-hashed shell assets from cache', async () => {
    let work: unknown;
    sw.listeners.install({ waitUntil: (v: unknown) => { work = v; } });
    await work;
    const res = await handleFetch(sw, 'https://host/app.abc123def456.js');
    expect(res).toEqual({ cached: true });
  });

  /*
   * The regression that produced the blank page. /desktop/app.js is not
   * content-hashed, so a cached copy would shadow every future build.
   */
  it('never intercepts the desktop bundle, which is not content-hashed', async () => {
    for (const url of ['https://host/desktop/app.js', 'https://host/desktop/boot.js', 'https://host/desktop/styles.css']) {
      expect(await handleFetch(sw, url)).toBeUndefined();
    }
  });

  it('does not cache the desktop bundle even after it is requested', async () => {
    await handleFetch(sw, 'https://host/desktop/app.js');
    const cached = await sw.cacheStore.get('whim-shell-testbuild0001');
    expect(cached?.has('https://host/desktop/app.js')).toBeFalsy();
  });

  it('leaves the API alone so state is never answered from cache', async () => {
    expect(await handleFetch(sw, 'https://host/api/invoke')).toBeUndefined();
  });

  it('ignores cross-origin requests', async () => {
    expect(await handleFetch(sw, 'https://elsewhere/app.abc123def456.js')).toBeUndefined();
  });

  it('sends navigations to the network so the bundle reference is never stale', async () => {
    await handleFetch(sw, 'https://host/desktop/', 'navigate');
    expect(sw.fetched).toContain('https://host/desktop/');
  });

  it('ignores non-GET requests', async () => {
    let responded: unknown;
    sw.listeners.fetch({ request: { url: 'https://host/index.html', method: 'POST', mode: 'cors' }, respondWith: (v: unknown) => { responded = v; } });
    expect(responded).toBeUndefined();
  });
});
