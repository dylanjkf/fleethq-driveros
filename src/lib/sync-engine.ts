import { apiClient } from '@/api/client';
import {
  countDeadLetter,
  countOutbox,
  discardDeadLetter,
  getDeadLetter,
  getOutbox,
  markOutboxAttempt,
  moveToDeadLetter,
  removeFromOutbox,
  requeueDeadLetter,
} from './offline-db';

/** Outbox state pushed to subscribers: still-pending items and permanently-failed ones. */
export interface OutboxState {
  pending: number;
  failed: number;
}

type Listener = (state: OutboxState) => void;
const listeners = new Set<Listener>();
let draining = false;

/** Retry cadence for a stuck-but-retryable queue when no `online`/queue event
 *  arrives to trigger a drain (e.g. a persistent 5xx). Only armed in the real
 *  app via initSyncEngine, so unit tests that call drainOutbox directly never
 *  leak a timer. */
const PERIODIC_RETRY_MS = 30_000;

async function currentState(): Promise<OutboxState> {
  const [pending, failed] = await Promise.all([countOutbox(), countDeadLetter()]);
  return { pending, failed };
}

async function notifyListeners(): Promise<void> {
  const state = await currentState();
  listeners.forEach((l) => l(state));
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  void notifyListeners();
  return () => listeners.delete(listener);
}

/**
 * Whether a failed replay is worth retrying (transient) or permanent.
 *
 * The api client normalises every failure to an ApiClientError whose `status`
 * is 0 for "no response at all" (offline / network drop). Transient failures —
 * no response, 5xx, and the two "back off and try again" 4xxs (408 timeout,
 * 429 rate-limited) — keep the item queued in order. A genuine permanent client
 * error (any other 4xx: the server has definitively rejected this exact
 * mutation, and replaying it byte-for-byte will only be rejected again) is
 * dead-lettered instead, so it can't freeze everything queued behind it.
 * An unrecognised error shape defaults to retryable — we never discard a
 * captured mutation on a guess.
 */
function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  if (status === undefined || status === 0) return true;
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  if (status >= 400) return false;
  return true;
}

function describeError(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const message = (error as { message?: string } | null)?.message ?? String(error);
  return status ? `${status}: ${message}` : message;
}

/**
 * True when a replay failure actually means "already done". A state-transition
 * mutation (shift start/end) has no create-id to dedup on, so a replay after a
 * lost success returns a 409 like SHIFT_ALREADY_ACTIVE — the desired state
 * already holds. The item declares which codes to read that way, so we clear it
 * as a success instead of dead-lettering a successful action with a red banner.
 */
function isIdempotentReplay(error: unknown, item: { idempotentReplayCodes?: string[] }): boolean {
  const codes = item.idempotentReplayCodes;
  if (!codes || codes.length === 0) return false;
  const code = (error as { code?: string } | null)?.code;
  return typeof code === 'string' && codes.includes(code);
}

/**
 * Replays queued mutations in creation order.
 *
 * A transient failure (offline, 5xx, 408/429) stops the pass at that item so
 * nothing jumps ahead of it — the queue stays strictly ordered and is retried
 * on the next `online` event, the next queued mutation, or the periodic timer.
 * A permanent client error (a non-retryable 4xx) is moved to the dead-letter
 * store and the drain *continues* past it, so one poison mutation can't block
 * every later one (a POD, a fault report, an "I need help" message) from ever
 * sending — the single most dangerous offline failure mode for a driver in a
 * dead zone.
 */
export async function drainOutbox(): Promise<void> {
  if (draining || !navigator.onLine) return;
  draining = true;
  try {
    const items = await getOutbox();
    for (const item of items) {
      try {
        await apiClient.request({ method: item.method, url: item.url, data: item.body });
        await removeFromOutbox(item.id);
      } catch (error) {
        if (isIdempotentReplay(error, item)) {
          // The action already took effect on a prior attempt whose response was
          // lost — treat this "conflict" as the success it really is.
          await removeFromOutbox(item.id);
          continue;
        }
        if (isRetryable(error)) {
          // Keep FIFO: record the attempt and stop; the rest stays queued.
          await markOutboxAttempt(item.id, (item.attempts ?? 0) + 1, describeError(error));
          break;
        }
        // Permanent: set it aside and keep draining the rest of the queue.
        await moveToDeadLetter(item, describeError(error));
      }
    }
  } finally {
    draining = false;
    await notifyListeners();
  }
}

/** Move every dead-lettered item back onto the queue and try again — the
 *  driver's self-rescue path once the underlying cause is fixed. */
export async function retryDeadLettered(): Promise<void> {
  const failed = await getDeadLetter();
  for (const item of failed) await requeueDeadLetter(item.id);
  await notifyListeners();
  await drainOutbox();
}

/**
 * Permanently discard the failed items. The other half of self-rescue: some
 * dead-lettered mutations will *never* succeed on replay — a stop the office
 * already completed a different way, a shift already ended from another device.
 * Retrying those just re-fails them forever, so the driver needs a way to clear
 * them and get the red banner off their screen. Without this the failed count
 * could only ever grow. Passing no id discards them all (the banner's bulk
 * action); passing one discards just that item.
 */
export async function discardDeadLettered(id?: string): Promise<void> {
  if (id) {
    await discardDeadLetter(id);
  } else {
    const failed = await getDeadLetter();
    for (const item of failed) await discardDeadLetter(item.id);
  }
  await notifyListeners();
}

export function initSyncEngine(): void {
  window.addEventListener('online', () => void drainOutbox());
  // A periodic sweep so a transient failure that outlasts the `online` event
  // (a server 5xx that later recovers) still drains without user action.
  window.setInterval(() => void drainOutbox(), PERIODIC_RETRY_MS);
  void drainOutbox();
}
