/**
 * Registers the service worker on app startup so the app-shell cache (see
 * public/sw.js) is populated the first time the operator opens DriverOS
 * online — which is what makes a later offline reload boot instead of showing
 * a blank page. Previously the worker was only registered lazily when a user
 * enabled push, so an operator who never turned push on had no offline shell
 * at all.
 *
 * Service workers only register in a secure context (HTTPS or localhost) —
 * over a plain-http LAN address (e.g. a tablet hitting http://192.168.x.x)
 * the browser refuses, so this is a silent no-op there rather than an error.
 * That's expected; see 04-DriverOS/DriverOS_Overview.md's run notes.
 *
 * PROD-only: sw.js caches every same-origin GET (stale-while-revalidate) by
 * exact request URL, which is safe for a production build's content-hashed
 * asset filenames but actively harmful in `vite dev` — dev serves unhashed
 * module URLs that change content without changing URL, so the worker would
 * keep serving a byte-for-byte stale module from a previous dev session
 * (surfaces as "Failed to fetch dynamically imported module" on first
 * navigation to a route). In dev we instead tear down any worker + cache a
 * previous (pre-fix) dev session left behind.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  if (!import.meta.env.PROD) {
    void navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
    void caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Insecure context (plain-http LAN) or unsupported browser — fine, the
      // app still runs online; it just doesn't get the offline shell here.
    });
  });

  // The push service worker posts a { type: 'navigate', path } message when a
  // notification is tapped; route to it. A full page navigation is used
  // deliberately — it's robust regardless of the current router state and a
  // notification tap is an infrequent, intentional context switch.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'navigate' && typeof event.data.path === 'string') {
      window.location.assign(event.data.path);
    }
  });
}
