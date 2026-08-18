/**
 * sw.js
 * -------------------------------------------------------------
 * Service Worker for مركز الأستاذ محمود الصياد للتطوير التعليمي
 *
 * Strategy:
 *   - App shell (HTML/CSS/JS/manifest/icons/fonts): cache-first,
 *     falling back to network, so the app is 100% usable offline
 *     after the first visit.
 *   - Navigation requests: network-first with cache fallback, so
 *     users always get the freshest shell when online, but still
 *     get a working app when offline.
 *   - Everything else (e.g. any future API GETs): network-first
 *     with cache fallback.
 * -------------------------------------------------------------
 */

const CACHE_VERSION = 'v1.2.3';
const STATIC_CACHE = `sayyad-static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `sayyad-runtime-${CACHE_VERSION}`;

const APP_SHELL_URLS = [
  './',
  './index.html',
  './styles.css',
  './db.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Cairo:wght@400;500;600;700;800;900&family=Tajawal:wght@400;500;700;900&display=swap',
];

/* ------------------------------------------------------------ */
/* INSTALL — pre-cache the full app shell                        */
/* ------------------------------------------------------------ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        // Cache each URL individually so a single failure (e.g. a
        // font CDN hiccup) doesn't block the whole install.
        return Promise.all(
          APP_SHELL_URLS.map((url) =>
            cache.add(url).catch((err) => {
              console.warn('[SW] تعذّر تخزين', url, err);
            })
          )
        );
      })
      .then(() => self.skipWaiting())
  );
});

/* ------------------------------------------------------------ */
/* ACTIVATE — clean up old cache versions                        */
/* ------------------------------------------------------------ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ------------------------------------------------------------ */
/* FETCH — routing strategies                                    */
/* ------------------------------------------------------------ */
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests; let POST (e.g. API sync calls) pass through
  // untouched so they hit the network directly and fail/succeed naturally.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Navigation requests (loading the app itself) -> network-first.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // Same-origin static assets -> cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Cross-origin (fonts, CDN) -> cache-first as well, since these rarely
  // change and offline support matters more than freshness here.
  event.respondWith(cacheFirst(request));
});

/* ------------------------------------------------------------ */
/* STRATEGIES                                                     */
/* ------------------------------------------------------------ */

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Last resort: if it's a navigation, serve the cached shell.
    const fallback = await caches.match('./index.html');
    if (fallback) return fallback;
    return new Response('لا يوجد اتصال بالإنترنت ولا توجد نسخة مخزنة مؤقتًا.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const fallback = await caches.match('./index.html');
    if (fallback) return fallback;
    return new Response('لا يوجد اتصال بالإنترنت ولا توجد نسخة مخزنة مؤقتًا.', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

/* ------------------------------------------------------------ */
/* BACKGROUND SYNC (progressive enhancement)                     */
/* ------------------------------------------------------------ */
// The main sync loop lives in app.js (interval + online-event based) so it
// works consistently across all browsers. This listener is an optional
// enhancement for browsers that support the Background Sync API — it just
// notifies open app windows to run the sync routine immediately.
self.addEventListener('sync', (event) => {
  if (event.tag === 'sayyad-sync-queue') {
    event.waitUntil(notifyClientsToSync());
  }
});

async function notifyClientsToSync() {
  const clientsList = await self.clients.matchAll({ type: 'window' });
  clientsList.forEach((client) => {
    client.postMessage({ type: 'SAYYAD_TRIGGER_SYNC' });
  });
}

/* ------------------------------------------------------------ */
/* MESSAGE — allow the page to force-update the SW immediately   */
/* ------------------------------------------------------------ */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
