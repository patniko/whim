/*
 * Offline shell for the whim remote.
 *
 * Deliberately narrow: only the app shell (hashed bundle, stylesheet, icons)
 * is cached. Nothing under /api is ever cached — workspace data is live state
 * and a stale answer to `agent:list-all` is worse than no answer. The service
 * worker exists so the app opens instantly and installs to the home screen,
 * not to make whim work offline.
 *
 * The cache name is derived from the hashed asset list, so a new build
 * produces a new cache and the old one is dropped on activate.
 */

const SHELL = self.__WHIM_SHELL__ || [];
const CACHE = `whim-shell-${self.__WHIM_BUILD__ || 'dev'}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      // A single missing asset must not wedge the install; the app still works
      // online, it just won't have a warm shell.
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // Navigations go to the network first: index.html carries the bundle
  // reference, and serving a stale one would pin the app to an old build.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((hit) => hit || Response.error())),
    );
    return;
  }

  // Everything else in the shell is content-hashed, so cache-first is safe.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});

// Clicking a notification should focus the existing app rather than opening
// a second copy of it.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
