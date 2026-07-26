/* Scriptorium service worker.
 *
 * Scope is deliberately narrow. This app's data lives on your disk behind the
 * local API, so there is nothing useful to cache there: /api/ always goes to
 * the network and is never stored. What the worker does buy you is a shell
 * that opens with no network — useful on a phone that has been added to the
 * home screen and lost its Wi-Fi on the way to the café.
 */

const VERSION = 'scriptorium-v1';
const SHELL = `${VERSION}-shell`;
const ASSETS = `${VERSION}-assets`;

// The minimum needed to paint the editor.
const SHELL_URLS = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/vendor-fonts.css',
  '/icon.svg',
  '/manifest.webmanifest',
  '/locales/en.json',
  '/locales/fr.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // Individually, so one 404 cannot fail the whole install.
    await Promise.all(SHELL_URLS.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Live disk state — never served from a cache, never stored.
  if (url.pathname.startsWith('/api/')) return;

  // Vendored libraries and fonts are versioned by their package, so a hit is
  // always correct and saves the round trip.
  if (url.pathname.startsWith('/vendor')) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(ASSETS);
        cache.put(request, response.clone());
      }
      return response;
    })());
    return;
  }

  // Shell: prefer the network so edits to app.js show up on reload, fall back
  // to the cached copy when offline.
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(SHELL);
        cache.put(request, response.clone());
      }
      return response;
    } catch (err) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
