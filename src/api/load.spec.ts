import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { LoadStatus } from './load';

/**
 * Part 3: a parcel scanned on the Confirm-load screen while offline must survive
 * an app restart in a dead zone. The screen persists the optimistic status via
 * `cacheLoadStatus`; on restart `getLoadStatus` reads that cache when the network
 * is down. This exercises the REAL offline-db (fake-indexeddb) round-trip — not a
 * mock — with only the axios client stubbed to toggle online/offline.
 */
const get = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ apiClient: { get } }));

function statusWith(a2Scanned: boolean): LoadStatus {
  return {
    jobId: 'job-1',
    stops: [
      {
        stopId: 'stop-1',
        label: 'Stop A',
        parcels: [
          { id: 'p1', reference: 'A-1', scannedAt: '2026-08-12T00:00:00Z' },
          { id: 'p2', reference: 'A-2', scannedAt: a2Scanned ? '2026-08-13T00:00:00Z' : null },
        ],
        scannedCount: a2Scanned ? 2 : 1,
        expectedCount: 2,
      },
    ],
    expectedTotal: 2,
    scannedTotal: a2Scanned ? 2 : 1,
    discrepancies: a2Scanned ? [] : [{ stopId: 'stop-1', stopLabel: 'Stop A', parcelId: 'p2', reference: 'A-2' }],
    loadVerifiedAt: null,
  };
}

describe('load-status offline persistence (Part 3)', () => {
  let load: typeof import('./load');
  beforeEach(async () => {
    // Fresh in-memory IndexedDB + module registry per test — offline-db caches
    // its DB connection in a module singleton (see offline-db.spec.ts).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).indexedDB = new IDBFactory();
    vi.resetModules();
    get.mockReset();
    load = await import('./load');
  });

  it('a scanned parcel cached offline survives a restart — getLoadStatus offline returns it as scanned', async () => {
    // The office originally listed A-2 as missing; a live sync cached that.
    get.mockResolvedValueOnce({ data: statusWith(false) });
    const initial = await load.getLoadStatus('job-1');
    expect(initial.stops[0].parcels.find((p) => p.reference === 'A-2')!.scannedAt).toBeNull();

    // Driver scans A-2 while offline → the screen persists the optimistic status.
    await load.cacheLoadStatus(statusWith(true));

    // App restarts while STILL offline: the network read fails, so getLoadStatus
    // falls back to the cache — which must now show A-2 scanned, not missing.
    get.mockRejectedValueOnce(new Error('offline'));
    const restored = await load.getLoadStatus('job-1');
    expect(restored.stops[0].parcels.find((p) => p.reference === 'A-2')!.scannedAt).toBeTruthy();
    expect(restored.discrepancies).toHaveLength(0);
    expect(restored.scannedTotal).toBe(2);
  });
});
