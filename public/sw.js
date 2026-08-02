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

// CACHE_VERSION is the SINGLE SOURCE OF TRUTH for cache rotation. Bumping this
// one constant renames every cache below, so the `activate` handler deletes the
// entire previous generation — no more hand-editing two separate `-v1` literals
// in lock-step (the old footgun: bump one, forget the other, and a stale asset
// cache leaks past the release it was meant to be retired with).
//
// This is still a hand-bumped constant, not a build-hash. A FULLY-AUTOMATIC
// rotation (cache name === the build's content hash, so every deploy rotates
// with zero human action) needs build tooling: sw.js is copied verbatim from
// `public/` by Vite and is NOT part of the bundle, so it can't `import` a
// generated version. The self-contained options are (a) a Vite plugin that
// string-replaces a `__CACHE_VERSION__` placeholder in this file at build time
// with `import.meta.env`/a git SHA, or (b) generating sw.js from a template in
// a build step. Both are build-config changes deliberately left out of this
// change; the safe, self-contained wins — a single-source version constant plus
// real size/age bounding — are done here.
const CACHE_VERSION = 'v1';

// Two caches with distinct lifetimes so the runtime asset cache can be size-
// bounded without ever evicting the boot shell:
//   - SHELL_CACHE: '/', '/index.html' — cached at install, never trimmed, so an
//     offline reload always has a shell to boot.
//   - ASSET_CACHE: content-hashed JS/CSS/images/fonts — stale-while-revalidate,
//     bounded by BOTH entry count (MAX_ASSET_ENTRIES) and age (MAX_ASSET_AGE_MS).
//     Because production filenames are hashed, a new release adds entries under
//     new names; without a cap this cache grew unbounded across releases (old
//     hashes were never evicted — the exact storage-quota risk the offline
//     outbox is meant to guard against). Trimming oldest-first (Cache API keys()
//     preserve insertion order) plus dropping anything staler than the age limit
//     keeps it bounded.
const SHELL_CACHE = `driveros-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `driveros-assets-${CACHE_VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];
const APP_SHELL = '/index.html';
const MAX_ASSET_ENTRIES = 80;
// Evict cached assets older than 30 days regardless of entry count, so a rarely-
// updated install can't hoard byte-for-byte-stale assets indefinitely.
const MAX_ASSET_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Header stamped on each cached asset so age can be computed on eviction. The
// Cache API stores no insertion time of its own, so we carry one on the stored
// copy. It's added only to the CACHED response; the client is always served the
// untouched network response.
const CACHED_AT_HEADER = 'x-sw-cached-at';

// Re-wrap a response with a cached-at timestamp header so trimCache can age it
// out later. Reads the (cloned) body into memory — fine for hashed static
// assets; never used on navigations or API responses.
async function stampResponse(response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT_HEADER, Date.now().toString());
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// Bound a cache by age first (drop anything past maxAgeMs), then by entry count
// (drop the oldest — Cache API keys() are insertion-ordered — until <= maxEntries).
async function trimCache(cache, { maxEntries, maxAgeMs } = {}) {
  if (maxAgeMs) {
    const now = Date.now();
    const keys = await cache.keys();
    await Promise.all(
      keys.map(async (request) => {
        const res = await cache.match(request);
        const stampedAt = Number(res && res.headers.get(CACHED_AT_HEADER));
        if (stampedAt && now - stampedAt > maxAgeMs) await cache.delete(request);
      }),
    );
  }
  if (maxEntries) {
    const keys = await cache.keys();
    if (keys.length > maxEntries) {
      await Promise.all(keys.slice(0, keys.length - maxEntries).map((k) => cache.delete(k)));
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(['/', APP_SHELL])).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !CURRENT_CACHES.includes(k)).map((k) => caches.delete(k))))
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

  // Static assets: stale-while-revalidate, into the size-capped asset cache.
  event.respondWith(
    caches.open(ASSET_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            // Store a timestamp-stamped copy, then bound the cache by entry count
            // AND age so it can't grow unbounded across releases. Fire-and-forget:
            // stamping/trimming must never delay the response returned to the page,
            // which is always the untouched network `response`.
            void stampResponse(response.clone())
              .then((stamped) => cache.put(request, stamped))
              .then(() => trimCache(cache, { maxEntries: MAX_ASSET_ENTRIES, maxAgeMs: MAX_ASSET_AGE_MS }));
          }
          return response;
        })
        .catch(() => undefined);
      return cached || (await network) || fetch(request);
    }),
  );
});

// --- Background Sync ---------------------------------------------------------
// The app (src/lib/sync-engine.ts) registers a 'driveros-outbox' sync when it
// queues a mutation offline. The browser fires this event once connectivity
// returns — including while the app is only backgrounded, not foreground-
// focused, which the app's own `online`/interval drains can't cover. We wake
// any client window to run its drainOutbox(); a fully-closed-app drain from the
// worker itself is a deliberate follow-up (it needs the ordered-replay/dead-
// letter logic ported in, which is safety-critical and out of scope here).
self.addEventListener('sync', (event) => {
  if (event.tag !== 'driveros-outbox') return;
  event.waitUntil(
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'drain-outbox' });
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
