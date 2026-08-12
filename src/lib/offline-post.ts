import { apiClient, ApiClientError } from '@/api/client';
import { queueMutation } from '@/lib/offline-db';
import { drainOutbox } from '@/lib/sync-engine';

export interface PostOrQueueOptions {
  /**
   * Request body, used for both the live POST and the queued outbox item. Omit
   * (or pass undefined) to POST with no body — matching a bare
   * `apiClient.post(url)`; the queued copy then stores an empty object, exactly
   * as the per-module wrappers did before this helper was extracted.
   */
  body?: unknown;
  /**
   * Server codes that mean "the desired state already holds", so a replay that
   * hits them is an idempotent success rather than a failure (used by the shift
   * start/end mutations — see offline-db's OutboxItem.idempotentReplayCodes).
   */
  idempotentReplayCodes?: string[];
}

/**
 * The offline-fallback wrapper shared by every DriverOS write path: POST while
 * online, but when the device is offline (`navigator.onLine === false`) or the
 * POST comes back as a pure network failure (`ApiClientError.status === 0`),
 * queue the mutation to the outbox, kick a background drain, and return
 * `{ queued: true }` instead of throwing.
 *
 * Preserves the exact semantics of the hand-written copies it replaced:
 *  - A real server verdict (any non-zero status — 4xx/5xx) still throws.
 *  - An `OutboxQuotaError` from a full device propagates out of `queueMutation`
 *    unchanged, so callers can tell the driver their capture was NOT saved.
 */
export async function postOrQueue(url: string, options: PostOrQueueOptions = {}): Promise<{ queued: boolean }> {
  const { body, idempotentReplayCodes } = options;
  const queuedItem = {
    method: 'POST' as const,
    url,
    body: body ?? {},
    ...(idempotentReplayCodes ? { idempotentReplayCodes } : {}),
  };
  if (!navigator.onLine) {
    await queueMutation(queuedItem);
    return { queued: true };
  }
  try {
    await apiClient.post(url, body);
    return { queued: false };
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 0) {
      await queueMutation(queuedItem);
      void drainOutbox();
      return { queued: true };
    }
    throw err;
  }
}
