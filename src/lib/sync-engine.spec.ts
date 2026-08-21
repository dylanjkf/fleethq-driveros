import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type * as OfflineDb from './offline-db';
import type * as SyncEngine from './sync-engine';

const requestMock = vi.fn();
vi.mock('@/api/client', () => ({ apiClient: { request: (...args: unknown[]) => requestMock(...args) } }));

// A controllable current-driver token so ownership tagging (security audit H2)
// can be exercised: queueMutation tags items with the signed-in driver, and
// drainOutbox only replays the current driver's own items.
const tokenState = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('@/api/token-store', () => ({
  tokenStore: {
    get: () => tokenState.current,
    set: (t: string) => {
      tokenState.current = t;
    },
    clear: () => {
      tokenState.current = null;
    },
    subscribe: () => () => {},
  },
}));

/** Build a JWT-shaped token whose `sub` claim is `driverId` (only the payload matters). */
function tokenFor(driverId: string): string {
  const payload = btoa(JSON.stringify({ sub: driverId })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${payload}.signature`;
}
function signInAs(driverId: string): void {
  tokenState.current = tokenFor(driverId);
}
function signOut(): void {
  tokenState.current = null;
}

let offlineDb: typeof OfflineDb;
let syncEngine: typeof SyncEngine;

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
  requestMock.mockReset();
  // Default: a driver is signed in, so the existing single-driver tests queue
  // and drain under one consistent identity.
  signInAs('driver-default');
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

  it('dead-letters a retryable item that never succeeds after the attempt cap, and the queue drains past it', async () => {
    // Item a keeps failing in a *retryable* shape (a persistent 5xx) — the kind
    // that, without a cap, `break`s the pass forever and blocks everything behind
    // it. Item b (a driver's "need help" message) is queued after it and must
    // eventually get through. a is the poison; b is what a would otherwise strand.
    requestMock.mockImplementation((req: { url: string }) => {
      if (req.url === '/v1/a') return Promise.reject(Object.assign(new Error('server error'), { status: 503 }));
      return Promise.resolve({});
    });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/b', body: { n: 2 } });

    // Up to (but not reaching) the cap: a keeps FIFO — it stays queued and b is
    // held behind it, never attempted.
    for (let i = 0; i < syncEngine.MAX_RETRYABLE_ATTEMPTS - 1; i++) {
      await syncEngine.drainOutbox();
    }
    let remaining = await offlineDb.getOutbox();
    expect(remaining.map((i) => (i.body as { n: number }).n)).toEqual([1, 2]); // both still queued, order intact
    expect(remaining[0].attempts).toBe(syncEngine.MAX_RETRYABLE_ATTEMPTS - 1); // attempts accrued, one short of the cap
    expect(await offlineDb.getDeadLetter()).toEqual([]); // not poison yet
    expect(requestMock).not.toHaveBeenCalledWith(expect.objectContaining({ url: '/v1/b' })); // b never jumped ahead

    // The cap-hitting pass sets a aside and, in the SAME pass, lets b through.
    await syncEngine.drainOutbox();

    expect(await offlineDb.getOutbox()).toEqual([]); // a dead-lettered, b sent — nothing left blocking
    const dead = await offlineDb.getDeadLetter();
    expect(dead.map((i) => (i.body as { n: number }).n)).toEqual([1]); // a is the one set aside
    expect(dead[0].lastError).toContain('stuck after'); // per-item reason names the poison verdict...
    expect(dead[0].lastError).toContain('503'); // ...and carries the underlying error detail
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ url: '/v1/b' })); // b really did send
  });

  it('genuine offline never counts toward the poison cap — attempts do not accrue while offline', async () => {
    // A real dead zone must not slowly dead-letter good work: while offline the
    // drain returns before touching the queue, so no attempts are burned no
    // matter how many drains fire.
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });

    for (let i = 0; i < syncEngine.MAX_RETRYABLE_ATTEMPTS + 3; i++) {
      await syncEngine.drainOutbox();
    }

    expect(requestMock).not.toHaveBeenCalled();
    const remaining = await offlineDb.getOutbox();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].attempts ?? 0).toBe(0); // offline drains never advanced the counter
    expect(await offlineDb.getDeadLetter()).toEqual([]); // and never poisoned a genuinely-offline item
  });

  it('a 401 does not advance the poison cap — a good item survives repeated logged-out drains and still sends after re-auth', async () => {
    // Every pass 401s (token expired mid-shift). A 401 is a session signal, not
    // the item's fault, so it must never push a healthy item toward the cap —
    // otherwise a device left logged-out would dead-letter good work.
    requestMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });

    for (let i = 0; i < syncEngine.MAX_RETRYABLE_ATTEMPTS + 2; i++) {
      await syncEngine.drainOutbox();
    }

    expect(await offlineDb.getDeadLetter()).toEqual([]); // never dead-lettered despite many failed passes
    const remaining = await offlineDb.getOutbox();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].attempts ?? 0).toBe(0); // 401s did not burn the poison counter

    // Re-auth: the same item now sends on the first good pass.
    requestMock.mockReset();
    requestMock.mockResolvedValue({});
    await syncEngine.drainOutbox();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(await offlineDb.getOutbox()).toEqual([]);
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

  it('pauses (does not mass-dead-letter) on a 401 mid-drain — a token expiring with a queued batch preserves the whole queue', async () => {
    // Item a sends; item b hits a 401 (token expired). Every item AFTER b would
    // also 401 with the now-cleared token, so a 401 must NOT dead-letter b and
    // continue — it must stop and preserve b + everything behind it for auto-sync
    // after re-auth. Regression test for the shared-tablet mass-dead-letter bug.
    requestMock
      .mockResolvedValueOnce({}) // a succeeds
      .mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 })); // b: session ended

    await offlineDb.queueMutation({ method: 'POST', url: '/v1/a', body: { n: 1 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/b', body: { n: 2 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/c', body: { n: 3 } });

    await syncEngine.drainOutbox();

    // Stopped at b — c was never attempted this pass.
    expect(requestMock).toHaveBeenCalledTimes(2);
    // b and c are still queued (nothing lost), and NOTHING was dead-lettered.
    const remaining = await offlineDb.getOutbox();
    expect(remaining.map((i) => (i.body as { n: number }).n)).toEqual([2, 3]);
    expect(await offlineDb.getDeadLetter()).toEqual([]);
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

describe('drainOutbox — cross-driver ownership (security audit H2)', () => {
  /** Capture the latest OutboxState the sync engine publishes. */
  function trackState(): { last: SyncEngine.OutboxState | null } {
    const ref: { last: SyncEngine.OutboxState | null } = { last: null };
    syncEngine.subscribeOutbox((s) => {
      ref.last = s;
    });
    return ref;
  }

  it('never replays a different driver’s captured work under the current session, and never drops it', async () => {
    requestMock.mockResolvedValue({});

    // Driver A captures a delivery offline on a shared tablet.
    signInAs('driver-a');
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/jobs/pod', body: { pod: 'A signature' } });

    // A logs out (outbox is deliberately preserved) and driver B logs in.
    signOut();
    signInAs('driver-b');
    const state = trackState();

    await syncEngine.drainOutbox();

    // A's item was NOT sent under B's session...
    expect(requestMock).not.toHaveBeenCalled();
    // ...and was NOT silently dropped — it's still in the outbox...
    const remaining = await offlineDb.getOutbox();
    expect(remaining).toHaveLength(1);
    expect((remaining[0].body as { pod: string }).pod).toBe('A signature');
    // ...and is surfaced in an explicit "belongs to another driver" state.
    expect(state.last).toMatchObject({ pending: 0, foreign: 1 });
  });

  it('drains driver B’s own items while holding driver A’s in the same queue', async () => {
    requestMock.mockResolvedValue({});
    signInAs('driver-a');
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/jobs/pod', body: { who: 'a' } });
    signInAs('driver-b');
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/messages', body: { who: 'b' } });

    await syncEngine.drainOutbox();

    // Only B's item was sent; A's is untouched and still queued.
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0][0]).toMatchObject({ data: { who: 'b' } });
    const remaining = await offlineDb.getOutbox();
    expect(remaining.map((i) => (i.body as { who: string }).who)).toEqual(['a']);
  });

  it('lets the original driver sync their own held work once they sign back in', async () => {
    requestMock.mockResolvedValue({});
    signInAs('driver-a');
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/jobs/pod', body: { who: 'a' } });

    // B logs in and drains — A's item is held, not sent.
    signInAs('driver-b');
    await syncEngine.drainOutbox();
    expect(requestMock).not.toHaveBeenCalled();
    expect(await offlineDb.getOutbox()).toHaveLength(1);

    // A signs back in and drains — now it syncs.
    signInAs('driver-a');
    await syncEngine.drainOutbox();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(await offlineDb.getOutbox()).toEqual([]);
  });

  it('holds (does not replay) items whose owner is unknown — e.g. pre-tagging items backfilled by the migration', async () => {
    requestMock.mockResolvedValue({});
    // Simulate a legacy item captured before ownership tagging: queued with no
    // token → owner UNKNOWN_OWNER (the same value the v4→v5 migration backfills).
    signOut();
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/jobs/pod', body: { legacy: true } });

    signInAs('driver-b');
    const state = trackState();
    await syncEngine.drainOutbox();

    expect(requestMock).not.toHaveBeenCalled();
    expect(await offlineDb.getOutbox()).toHaveLength(1); // held, not lost
    expect(state.last).toMatchObject({ foreign: 1 });
  });
});

describe('dead-letter — cross-driver ownership (security audit H4)', () => {
  /** Capture the latest OutboxState the sync engine publishes. */
  function trackState(): { last: SyncEngine.OutboxState | null } {
    const ref: { last: SyncEngine.OutboxState | null } = { last: null };
    syncEngine.subscribeOutbox((s) => {
      ref.last = s;
    });
    return ref;
  }

  /** Sign in driver A and permanently fail one mutation so it dead-letters under A. */
  async function deadLetterOneFor(driverId: string): Promise<void> {
    signInAs(driverId);
    requestMock.mockReset();
    requestMock.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/jobs/pod', body: { who: driverId } });
    await syncEngine.drainOutbox();
    expect(await offlineDb.getDeadLetter(driverId)).toHaveLength(1);
  }

  it('a driver’s dead-lettered work is not counted or listed for a different driver', async () => {
    await deadLetterOneFor('driver-a');

    // Driver B signs in on the same shared tablet.
    signInAs('driver-b');
    const state = trackState();
    await syncEngine.subscribeOutbox(() => {}); // force a fresh publish
    // give the async currentState() publish a tick
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    // B's failed badge is 0; A's item is invisible to B but still there for A.
    expect(await offlineDb.countDeadLetter('driver-b')).toBe(0);
    expect(await offlineDb.getDeadLetter('driver-b')).toEqual([]);
    expect(await offlineDb.countDeadLetter('driver-a')).toBe(1);
    expect(state.last).toMatchObject({ failed: 0 });
  });

  it('discardDeadLettered (bulk) as another driver cannot wipe the first driver’s stranded POD', async () => {
    await deadLetterOneFor('driver-a');

    // B taps "discard all" on their (empty) banner — must not touch A's work.
    signInAs('driver-b');
    await syncEngine.discardDeadLettered();
    expect(await offlineDb.getDeadLetter('driver-a')).toHaveLength(1);

    // A signs back in and clears their own — that IS allowed.
    signInAs('driver-a');
    await syncEngine.discardDeadLettered();
    expect(await offlineDb.getDeadLetter('driver-a')).toEqual([]);
  });

  it('retryDeadLettered as another driver does not requeue the first driver’s work', async () => {
    await deadLetterOneFor('driver-a');

    signInAs('driver-b');
    requestMock.mockReset();
    requestMock.mockResolvedValue({});
    await syncEngine.retryDeadLettered();

    // Nothing of B's to retry; A's dead-letter is untouched (not requeued/sent).
    expect(requestMock).not.toHaveBeenCalled();
    expect(await offlineDb.getDeadLetter('driver-a')).toHaveLength(1);
    expect(await offlineDb.getOutbox()).toEqual([]);
  });

  // H4 follow-up #2: defense in depth — the offline-db primitives themselves
  // reject a cross-driver id, so safety no longer relies on the UI only ever
  // sourcing ids from the already-filtered banner list. These call the
  // primitives DIRECTLY, bypassing the sync-engine/UI path entirely.
  it('discardDeadLetter rejects a cross-driver id at the primitive layer (bypassing the UI list)', async () => {
    await deadLetterOneFor('driver-a');
    const [aItem] = await offlineDb.getDeadLetter('driver-a');

    // Driver B is signed in but calls the primitive directly with A's id.
    signInAs('driver-b');
    await expect(offlineDb.discardDeadLetter(aItem.id, 'driver-b')).rejects.toBeInstanceOf(offlineDb.CrossDriverError);

    // A's stranded POD is still there — nothing was discarded.
    expect(await offlineDb.getDeadLetter('driver-a')).toHaveLength(1);
  });

  it('requeueDeadLetter rejects a cross-driver id at the primitive layer (bypassing the UI list)', async () => {
    await deadLetterOneFor('driver-a');
    const [aItem] = await offlineDb.getDeadLetter('driver-a');

    signInAs('driver-b');
    await expect(offlineDb.requeueDeadLetter(aItem.id, 'driver-b')).rejects.toBeInstanceOf(offlineDb.CrossDriverError);

    // Not requeued: still dead-lettered under A, nothing back on the outbox.
    expect(await offlineDb.getDeadLetter('driver-a')).toHaveLength(1);
    expect(await offlineDb.getOutbox()).toEqual([]);
  });

  it('the primitives still let the rightful owner discard and requeue their own item', async () => {
    await deadLetterOneFor('driver-a');
    let [aItem] = await offlineDb.getDeadLetter('driver-a');

    // Requeue as A → back on the outbox, off the dead-letter store.
    await offlineDb.requeueDeadLetter(aItem.id, 'driver-a');
    expect(await offlineDb.getDeadLetter('driver-a')).toEqual([]);
    expect(await offlineDb.getOutbox()).toHaveLength(1);

    // Fail it again, then discard as A → gone.
    requestMock.mockReset();
    requestMock.mockRejectedValueOnce(Object.assign(new Error('bad request'), { status: 400 }));
    await syncEngine.drainOutbox();
    [aItem] = await offlineDb.getDeadLetter('driver-a');
    await offlineDb.discardDeadLetter(aItem.id, 'driver-a');
    expect(await offlineDb.getDeadLetter('driver-a')).toEqual([]);
  });

  // H4 follow-up #1: a foreign driver's *failures* are surfaced with their own
  // count (a banner), not hidden behind the owner-filtered `failed: 0`.
  it('publishes a foreignFailed count so another driver’s failures are surfaced, not hidden', async () => {
    await deadLetterOneFor('driver-a');

    // Ownership split, computed without deserialising bodies.
    expect(await offlineDb.countDeadLetterOwnership('driver-b')).toEqual({ own: 0, foreign: 1 });
    expect(await offlineDb.countDeadLetterOwnership('driver-a')).toEqual({ own: 1, foreign: 0 });

    // From B's session the published state hides A's item from `failed` but
    // exposes it via `foreignFailed` (drives the StatusBar banner).
    signInAs('driver-b');
    const state = trackState();
    syncEngine.subscribeOutbox(() => {}); // force a fresh publish
    // The publish is an async currentState() read over (fake) IndexedDB, which
    // can take several ticks — poll for the expected state instead of guessing a
    // single macrotask tick (a bare setTimeout(r,0) here raced ~1 in 3 runs).
    await vi.waitFor(() => expect(state.last).toMatchObject({ failed: 0, foreignFailed: 1 }));
  });
});
