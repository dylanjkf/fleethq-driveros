import { apiClient } from './client';
import { getCache, setCache } from '@/lib/offline-db';
import { postOrQueue } from '@/lib/offline-post';

/** One expected parcel on the run's manifest, with its loaded/scanned state. */
export interface LoadStatusParcel {
  id: string;
  reference: string;
  scannedAt: string | null;
}

export interface LoadStatusStop {
  stopId: string;
  label: string;
  parcels: LoadStatusParcel[];
  scannedCount: number;
  expectedCount: number;
}

export interface LoadStatusDiscrepancy {
  stopId: string;
  stopLabel: string;
  parcelId: string;
  reference: string;
}

/** Aggregated expected load for a run (GET /v1/jobs/:id/load-status). */
export interface LoadStatus {
  jobId: string;
  stops: LoadStatusStop[];
  expectedTotal: number;
  scannedTotal: number;
  discrepancies: LoadStatusDiscrepancy[];
  loadVerifiedAt: string | null;
}

function loadStatusCacheKey(jobId: string): string {
  return `load-status-${jobId}`;
}

/**
 * The run's expected load. Network-first, then the last-synced status — same
 * offline pattern as the per-stop parcel manifest. Cached so a driver who opens
 * "Confirm load" after signal drops still sees what the office expected loaded,
 * rather than a blank screen.
 */
export async function getLoadStatus(jobId: string): Promise<LoadStatus> {
  try {
    const { data } = await apiClient.get<LoadStatus>(`/v1/jobs/${jobId}/load-status`);
    await setCache(loadStatusCacheKey(jobId), data);
    return data;
  } catch (err) {
    const cached = await getCache<LoadStatus>(loadStatusCacheKey(jobId));
    if (cached) return cached.data;
    throw err;
  }
}

/**
 * Persist an optimistic load-status update — e.g. a parcel just scanned while
 * offline — to the SAME cache `getLoadStatus` reads back. Without this a scan
 * lives only in React state plus the replay outbox: an app restart in a dead
 * zone reloads the last server-synced status and the scanned parcel reappears as
 * "missing". Mirrors the offline persistence StopPage does via `cacheStopOutcome`.
 */
export async function cacheLoadStatus(status: LoadStatus): Promise<void> {
  await setCache(loadStatusCacheKey(status.jobId), status);
}

export interface VerifyLoadInput {
  confirm: boolean;
  /** Set only when the driver is knowingly proceeding past a discrepancy. */
  override?: boolean;
  /** The references the driver acknowledges as missing (advisory — server recomputes). */
  missingReferences?: string[];
}

/**
 * Verify the vehicle's load before starting the run. Offline (or on a network
 * failure) the verification queues to the same outbox deliveries use and
 * replays on reconnect; the server is idempotent on an already-verified job, so
 * a replay can't double-record. A clean-load or override verdict is what unlocks
 * the run for the office's records — see load-verification.service on the API.
 */
export async function verifyLoad(jobId: string, input: VerifyLoadInput): Promise<{ queued: boolean }> {
  const url = `/v1/jobs/${jobId}/load-verification`;
  return postOrQueue(url, { body: input });
}
