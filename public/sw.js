/* eslint-env serviceworker */
/*
 * DriverOS service worker. Two jobs:
 *
 * 1. App-shell / offline loading (04-DriverOS/DriverOS_Overview.md's
 *    "every core workflow functions with zero connectivity from login to end
 *    of shift"). Without this, the offline story was only half-built — the
 *    IndexedDB outbox/cache made *data* survive offline, but the app itself
 *    couldn't LOAD offline because nothing cached its HTML/JS/CSS. A driver
 *    who closed the tablet and reopened it in a dead zone got a blank page.
 *
 *    Strategy is runtime caching, not a precache manifest, so it's independent
 *    of the build's hashed filenames: the app's own assets are cached the
 *    first time they're fetched (which happens the moment the operator opens
 *    the app online at shift start), then served cache-first while offline.
 *      - Navigations: network-first, falling back to the cached app shell
 *        (index.html) so a reload offline still boots the SPA.
 *      - Same-origin static assets (JS/CSS/images/fonts): stale-while-
 *        revalidate — instant from cache, refreshed in the background.
 *      - API calls (/v1, /health): never cached here. Freshness and offline
 *        behaviour for data are the app's own job (offline-db.ts's outbox +
 *        last-known-good cache), which is deliberate and already built.
 *
 * 2. Web Push (unchanged from the original push-only worker): show the
 *    notification the backend sent, focus/open the linked page on click.
 */

const CACHE = 'driveros-shell-v1';
const APP_SHELL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(['/', APP_SHELL])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function isApiRequest(url) {
  return url.pathname.startsWith('/v1') || url.pathname.startsWith('/health');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // let cross-origin (e.g. Sentry) pass through
  if (isApiRequest(url)) return; // API data is the app's own offline concern, never cached here

  // SPA navigations: try network first (fresh app on reconnect), fall back to
  // the cached shell so the app still boots with no connectivity.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(APP_SHELL).then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => undefined);
      return cached || (await network) || fetch(request);
    }),
  );
});

// --- Web Push (unchanged behaviour) ------------------------------------------
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'FleetOS', body: event.data.text() };
  }
  const title = payload.title || 'FleetOS';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || '',
      data: { linkPath: payload.linkPath || '/' },
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const linkPath = event.notification.data?.linkPath || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'navigate', path: linkPath });
          return client.focus();
        }
      }
      return self.clients.openWindow(linkPath);
    }),
  );
});
