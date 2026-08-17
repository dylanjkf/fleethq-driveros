import { apiClient } from './client';
import { getCache, setCache } from '@/lib/offline-db';
import { postOrQueue } from '@/lib/offline-post';
import type { FormAnswer, Job, Paginated, StopFailureReason, StopOutcome } from './types';

const TODAY_CACHE_KEY = 'today-jobs';

export interface TodayJobs {
  items: Job[];
  fromCache: boolean;
  cachedAt?: number;
}

/**
 * DriverOS's "Today" screen: the operator's currently-assigned job(s). Tries
 * the network first and caches the result; if the fetch fails (offline), the
 * last cached result is returned instead, flagged so the UI can show it
 * honestly rather than pretending it's fresh.
 */
export async function getTodayJobs(operatorId: string): Promise<TodayJobs> {
  try {
    const { data } = await apiClient.get<Paginated<Job>>('/v1/jobs', {
      params: { operatorId, status: 'ASSIGNED', pageSize: 20 },
    });
    await setCache(TODAY_CACHE_KEY, data.items);
    return { items: data.items, fromCache: false };
  } catch (err) {
    const cached = await getCache<Job[]>(TODAY_CACHE_KEY);
    if (cached) {
      return { items: cached.data, fromCache: true, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}

/**
 * Reflect a completed stop in a Today job list. Pure, so the same transform
 * updates both the live React Query cache and the persisted offline cache from
 * one definition. Exported for its own unit test — this is what makes the list
 * update *offline*, where a refetch can't, so a stop just completed in a dead
 * zone stops saying "Deliver →".
 */
export function applyStopOutcome(
  items: Job[],
  jobId: string,
  stopId: string,
  outcome: Exclude<StopOutcome, 'PENDING'>,
): Job[] {
  return items.map((job) =>
    job.id !== jobId
      ? job
      : {
          ...job,
          stops: job.stops?.map((s) => (s.id === stopId ? { ...s, outcome, completedAt: new Date().toISOString() } : s)),
        },
  );
}

/** Persist an optimistic stop outcome into the offline Today cache, so a reload
 *  while still offline shows the stop as done rather than pending. */
export async function cacheStopOutcome(
  jobId: string,
  stopId: string,
  outcome: Exclude<StopOutcome, 'PENDING'>,
): Promise<void> {
  const cached = await getCache<Job[]>(TODAY_CACHE_KEY);
  if (!cached) return;
  await setCache(TODAY_CACHE_KEY, applyStopOutcome(cached.data, jobId, stopId, outcome));
}

export interface CompleteStopInput {
  outcome: Exclude<StopOutcome, 'PENDING'>;
  recipientName?: string;
  note?: string;
  failureReason?: StopFailureReason;
  /**
   * When the delivery actually happened, stamped on the device at capture time.
   * Sent so an offline completion that syncs hours later is still recorded at
   * the real delivery time, not at sync time — the office's on-time reporting
   * depends on it. The server clamps it to a sane window (never in the future).
   */
  occurredAt?: string;
  podPhotoBase64?: string;
  podPhotoContentType?: string;
  podPhotoFilename?: string;
  signatureBase64?: string;
  signatureContentType?: string;
  signatureFilename?: string;
  /**
   * Multi-drop: the specific parcels this completion covers. Omitted = every
   * parcel at the stop. Sent when the driver confirms a subset (or, in this
   * slice, one shared evidence capture covering all parcels at the stop).
   */
  parcelIds?: string[];
  /**
   * Configurable proof-of-delivery evidence, when the tenant has an active
   * DELIVERY form template. `answers` carries that template's field answers,
   * including `photo`/`signature` values as `{ contentType, filename, base64 }`.
   * The client-generated `id` makes an offline replay idempotent. Required by
   * the server iff a DELIVERY template is active (else 400 POD_EVIDENCE_REQUIRED);
   * omitted here on the legacy hardcoded photo/signature path.
   */
  evidence?: { id?: string; answers: FormAnswer[] };
}

/**
 * Completes a delivery stop with Proof of Delivery. Offline (or on a network
 * failure) the completion — including its base64 photo — is queued to the outbox
 * and replayed on reconnect. A replayed (or concurrent double-tap) completion is
 * idempotent server-side: completeStop runs its check-then-write under
 * SERIALIZABLE isolation and returns the already-completed stop unchanged (see
 * job-stops.service.ts), so a flaky reconnect can't double-record a delivery or
 * duplicate its timeline events/notifications.
 */
export async function completeStop(
  jobId: string,
  stopId: string,
  input: CompleteStopInput,
): Promise<{ queued: boolean }> {
  const url = `/v1/jobs/${jobId}/stops/${stopId}/complete`;
  return postOrQueue(url, { body: input });
}
