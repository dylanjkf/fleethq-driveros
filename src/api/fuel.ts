import { apiClient, ApiClientError } from './client';
import { queueMutation } from '@/lib/offline-db';
import { drainOutbox } from '@/lib/sync-engine';

export interface RecordFuelInput {
  odometerReading: number;
  licencePlate: string;
  cardLast4: string;
  litres?: number;
  totalCost?: number;
  assetId?: string;
  notes?: string;
  filledAt?: string;
  receiptBase64?: string;
  receiptFilename?: string;
  receiptContentType?: string;
}

/**
 * Records a fuel purchase, queueing it offline exactly like a POD completion —
 * a driver fuels up at a truck stop with no signal far more often than not, and
 * losing the receipt photo because of that would defeat the feature.
 *
 * `filledAt` is stamped by the caller so a queued entry keeps the time the tank
 * was actually filled rather than the time it happened to sync.
 */
export async function recordFuelEntry(input: RecordFuelInput): Promise<{ queued: boolean }> {
  const url = '/v1/fuel/entries';
  // Stamp a stable idempotency key once, up front: the SAME key is used for the
  // live POST and the queued body, so an outbox replay after a lost response is
  // deduplicated server-side and can't double-count the spend.
  const body = { ...input, clientRequestId: crypto.randomUUID() };
  if (!navigator.onLine) {
    await queueMutation({ method: 'POST', url, body });
    return { queued: true };
  }
  try {
    await apiClient.post(url, body);
    return { queued: false };
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 0) {
      await queueMutation({ method: 'POST', url, body });
      void drainOutbox();
      return { queued: true };
    }
    throw err;
  }
}
