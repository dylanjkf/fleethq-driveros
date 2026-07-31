import { apiClient, ApiClientError } from './client';
import { getCache, setCache, queueMutation } from '@/lib/offline-db';
import { drainOutbox } from '@/lib/sync-engine';

export interface Shift {
  id: string;
  status: 'ACTIVE' | 'ENDED';
  startedAt: string;
  endedAt: string | null;
}

const CACHE_KEY = 'shift-current';

export interface CurrentShiftResult {
  shift: Shift | null;
  fromCache: boolean;
  cachedAt?: number;
}

/**
 * Same network-first-then-cache pattern as Today's job list (`api/jobs.ts`)
 * — offline-first, always (CLAUDE.md), so the on/off-shift widget still
 * shows its last-known state with no connectivity.
 */
export async function getCurrentShift(): Promise<CurrentShiftResult> {
  try {
    const { data } = await apiClient.get<{ shift: Shift | null }>('/v1/shifts/current');
    await setCache(CACHE_KEY, data.shift);
    return { shift: data.shift, fromCache: false };
  } catch (err) {
    const cached = await getCache<Shift | null>(CACHE_KEY);
    if (cached) {
      return { shift: cached.data, fromCache: true, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}

/**
 * Start/end a shift offline (or on a network failure): queued to the same
 * outbox `completeStop` uses and replayed on reconnect, rather than the
 * action being silently lost — CLAUDE.md's "offline-first, always" applies
 * to clocking in/out exactly as much as it does to a delivery.
 */
async function postShiftAction(url: string, idempotentReplayCode: string): Promise<{ queued: boolean }> {
  // On an outbox replay, this specific 409 means the shift already reached the
  // desired state on an earlier attempt whose response was lost — so the sync
  // engine treats it as success, not a dead-lettered failure. (This applies
  // only to replays; a fresh online 409 below still surfaces as a real error.)
  const idempotentReplayCodes = [idempotentReplayCode];
  if (!navigator.onLine) {
    await queueMutation({ method: 'POST', url, body: {}, idempotentReplayCodes });
    return { queued: true };
  }
  try {
    await apiClient.post(url);
    return { queued: false };
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 0) {
      await queueMutation({ method: 'POST', url, body: {}, idempotentReplayCodes });
      void drainOutbox();
      return { queued: true };
    }
    throw err;
  }
}

export function startShift(): Promise<{ queued: boolean }> {
  return postShiftAction('/v1/shifts/start', 'SHIFT_ALREADY_ACTIVE');
}

export function endShift(): Promise<{ queued: boolean }> {
  return postShiftAction('/v1/shifts/end', 'SHIFT_NOT_ACTIVE');
}

/**
 * Persist an optimistic shift state to the offline cache after a queued
 * start/end. Without this the widget refetches, fails offline, and falls back to
 * the *old* cached state — so a driver who taps "Start shift" in a dead zone
 * still sees "Start shift", taps again, and queues a second start the server
 * later rejects (dead-lettering it). Reflecting the intended state immediately
 * is what stops that duplicate. The server's real shift replaces this on sync.
 */
export async function cacheOptimisticShift(shift: Shift | null): Promise<void> {
  await setCache(CACHE_KEY, shift);
}
