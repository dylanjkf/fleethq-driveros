import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type * as OfflineDb from './offline-db';
import type * as SyncEngine from './sync-engine';

const requestMock = vi.fn();
vi.mock('@/api/client', () => ({ apiClient: { request: (...args: unknown[]) => requestMock(...args) } }));

let offlineDb: typeof OfflineDb;
let syncEngine: typeof SyncEngine;

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
  requestMock.mockReset();
  vi.resetModules();
  offlineDb = await import('./offline-db');
  syncEngine = await import('./sync-engine');
  vi.stubGlobal('navigator', { ...navigator, onLine: true });
});

describe('drainOutbox', () => {
  it('replays every queued item in order and empties the outbox on full success', async () => {
    requestMock.mockResolvedValue({});
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/b', body: { n: 2 } });

    await syncEngine.drainOutbox();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0][0]).toMatchObject({ url: '/v1/a', method: 'POST', data: { n: 1 } });
    expect(requestMock.mock.calls[1][0]).toMatchObject({ url: '/v1/b', method: 'POST', data: { n: 2 } });
    expect(await offlineDb.getOutbox()).toEqual([]);
  });

  it('stops at the first failure — a later item never jumps ahead of a stuck earlier one, and no data is lost', async () => {
    requestMock
      .mockResolvedValueOnce({}) // first item succeeds
      .mockRejectedValueOnce(new Error('network error')); // second item fails

    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/b', body: { n: 2 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/c', body: { n: 3 } });

    await syncEngine.drainOutbox();

    // Only the first request was ever attempted for item b's failure to stop
    // the third item from being tried at all this round.
    expect(requestMock).toHaveBeenCalledTimes(2);
    const remaining = await offlineDb.getOutbox();
    expect(remaining.map((i) => (i.body as { n: number }).n)).toEqual([2, 3]); // the failed item and everything after it stay queued, nothing lost
  });

  it('does nothing while offline — no requests attempted, nothing removed from the queue', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });

    await syncEngine.drainOutbox();

    expect(requestMock).not.toHaveBeenCalled();
    expect(await offlineDb.getOutbox()).toHaveLength(1);
  });

  it('a subsequent drain call retries the whole remaining queue, not just the item that failed', async () => {
    requestMock.mockRejectedValueOnce(new Error('network error'));
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });
    await syncEngine.drainOutbox();
    expect(await offlineDb.getOutbox()).toHaveLength(1);

    requestMock.mockReset();
    requestMock.mockResolvedValue({}); // connectivity is back
    await syncEngine.drainOutbox();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(await offlineDb.getOutbox()).toEqual([]);
  });

  it('dead-letters a permanent 4xx and CONTINUES past it — a poison item never blocks the rest of the queue', async () => {
    // Item b is permanently rejected (e.g. a stop already completed); a and c
    // are fine. b must not stop c from sending.
    requestMock
      .mockResolvedValueOnce({}) // a succeeds
      .mockRejectedValueOnce(Object.assign(new Error('already completed'), { status: 409 })) // b poison
      .mockResolvedValueOnce({}); // c succeeds

    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/b', body: { n: 2 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/c', body: { n: 3 } });

    await syncEngine.drainOutbox();

    // All three were attempted; a and c cleared; b moved to the dead-letter store.
    expect(requestMock).toHaveBeenCalledTimes(3);
    expect(await offlineDb.getOutbox()).toEqual([]);
    const dead = await offlineDb.getDeadLetter();
    expect(dead.map((i) => (i.body as { n: number }).n)).toEqual([2]);
    expect(dead[0].lastError).toContain('409');
  });

  it('a transient failure keeps FIFO (stops the pass) while a later permanent one would not', async () => {
    // b fails transiently (5xx) → stop; c is never reached this pass.
    requestMock
      .mockResolvedValueOnce({}) // a
      .mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 503 })); // b transient

    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/b', body: { n: 2 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/c', body: { n: 3 } });

    await syncEngine.drainOutbox();

    expect(requestMock).toHaveBeenCalledTimes(2); // stopped at b
    const remaining = await offlineDb.getOutbox();
    expect(remaining.map((i) => (i.body as { n: number }).n)).toEqual([2, 3]);
    expect(remaining[0].attempts).toBe(1); // the failed attempt was recorded
    expect(await offlineDb.getDeadLetter()).toEqual([]); // nothing dead-lettered
  });

  it('treats a declared idempotent-replay conflict as success — a replayed shift start that returns SHIFT_ALREADY_ACTIVE clears, not dead-letters', async () => {
    // The action succeeded on an earlier attempt whose response was lost; the
    // replay hits a 409 the item declares as "already done". It must NOT dead-
    // letter (which would show the driver a false red-banner failure), and the
    // rest of the queue must still drain.
    requestMock
      .mockRejectedValueOnce(Object.assign(new Error('A shift is already active.'), { status: 409, code: 'SHIFT_ALREADY_ACTIVE' }))
      .mockResolvedValueOnce({}); // the next item still sends

    await offlineDb.queueMutation({ method: 'POST', url: '/v1/shifts/start', body: {}, idempotentReplayCodes: ['SHIFT_ALREADY_ACTIVE'] });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/b', body: { n: 2 } });

    await syncEngine.drainOutbox();

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(await offlineDb.getOutbox()).toEqual([]); // both cleared
    expect(await offlineDb.getDeadLetter()).toEqual([]); // the 409 was NOT a failure
  });

  it('an undeclared conflict code on the same item still dead-letters (only declared codes are idempotent)', async () => {
    requestMock.mockRejectedValueOnce(Object.assign(new Error('some other conflict'), { status: 409, code: 'SOMETHING_ELSE' }));
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/shifts/start', body: {}, idempotentReplayCodes: ['SHIFT_ALREADY_ACTIVE'] });

    await syncEngine.drainOutbox();

    expect(await offlineDb.getOutbox()).toEqual([]);
    expect(await offlineDb.getDeadLetter()).toHaveLength(1); // not a declared idempotent code → dead-lettered
  });

  it('retryDeadLettered re-queues failed items and drains them once the cause is resolved', async () => {
    requestMock.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });
    await syncEngine.drainOutbox();
    expect(await offlineDb.getDeadLetter()).toHaveLength(1);
    expect(await offlineDb.getOutbox()).toEqual([]);

    // The underlying cause is fixed; the driver taps Retry.
    requestMock.mockReset();
    requestMock.mockResolvedValue({});
    await syncEngine.retryDeadLettered();

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(await offlineDb.getDeadLetter()).toEqual([]);
    expect(await offlineDb.getOutbox()).toEqual([]);
  });
});
