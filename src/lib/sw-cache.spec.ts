import { describe, expect, it } from 'vitest';

/*
 * public/sw.js is a standalone service-worker script served verbatim from
 * `public/` (NOT part of the Vite bundle) and registers top-level
 * `self.addEventListener(...)` / touches the `caches` global at import time, so
 * it cannot be imported into a headless vitest run. The Cache API it bounds is
 * also browser/SW-only. So this is a PURE-LOGIC MIRROR of sw.js's `trimCache`
 * eviction algorithm, exercised against a minimal in-memory Cache stub, to prove
 * the size/age bounding actually evicts. It must be kept in step with sw.js.
 */

const CACHED_AT_HEADER = 'x-sw-cached-at';

// Minimal insertion-ordered Cache stub: enough of the Cache API surface that
// trimCache uses (keys / match / delete). Mirrors the real API's guarantee that
// keys() returns entries in insertion order (oldest first).
function makeCacheStub() {
  const store = new Map<string, { headers: Map<string, string> }>();
  return {
    _store: store,
    async put(key: string, cachedAt: number | null) {
      const headers = new Map<string, string>();
      if (cachedAt !== null) headers.set(CACHED_AT_HEADER, String(cachedAt));
      store.set(key, { headers });
    },
    async keys() {
      return [...store.keys()];
    },
    async match(key: string) {
      const entry = store.get(key);
      if (!entry) return undefined;
      return { headers: { get: (h: string) => entry.headers.get(h) ?? null } };
    },
    async delete(key: string) {
      return store.delete(key);
    },
  };
}

// Verbatim copy of public/sw.js's trimCache — keep in sync.
async function trimCache(
  cache: ReturnType<typeof makeCacheStub>,
  { maxEntries, maxAgeMs }: { maxEntries?: number; maxAgeMs?: number } = {},
) {
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

describe('sw.js trimCache (pure-logic mirror)', () => {
  it('evicts the oldest entries beyond the entry-count limit, keeping the newest', async () => {
    const cache = makeCacheStub();
    for (let i = 0; i < 5; i++) await cache.put(`asset-${i}`, Date.now());

    await trimCache(cache, { maxEntries: 3 });

    // Oldest two (asset-0, asset-1) evicted; three newest retained in order.
    expect(await cache.keys()).toEqual(['asset-2', 'asset-3', 'asset-4']);
  });

  it('does nothing when the cache is within the entry limit', async () => {
    const cache = makeCacheStub();
    await cache.put('a', Date.now());
    await cache.put('b', Date.now());

    await trimCache(cache, { maxEntries: 5 });

    expect(await cache.keys()).toEqual(['a', 'b']);
  });

  it('evicts entries older than the age limit regardless of count', async () => {
    const cache = makeCacheStub();
    const now = Date.now();
    await cache.put('stale', now - 60 * 24 * 60 * 60 * 1000); // 60 days old
    await cache.put('fresh', now - 60 * 1000); // 1 minute old

    await trimCache(cache, { maxEntries: 80, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });

    expect(await cache.keys()).toEqual(['fresh']);
  });

  it('applies age then entry bounds together', async () => {
    const cache = makeCacheStub();
    const now = Date.now();
    await cache.put('stale', now - 40 * 24 * 60 * 60 * 1000); // dropped by age
    await cache.put('old-fresh', now - 3 * 60 * 60 * 1000);
    await cache.put('mid-fresh', now - 2 * 60 * 60 * 1000);
    await cache.put('new-fresh', now - 1 * 60 * 60 * 1000);

    // After age eviction 3 fresh remain; entry cap of 2 drops the oldest of those.
    await trimCache(cache, { maxEntries: 2, maxAgeMs: 30 * 24 * 60 * 60 * 1000 });

    expect(await cache.keys()).toEqual(['mid-fresh', 'new-fresh']);
  });
});
