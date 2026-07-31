import { apiClient, ApiClientError } from './client';
import { getCache, setCache, queueMutation } from '@/lib/offline-db';
import { drainOutbox } from '@/lib/sync-engine';

export interface Parcel {
  id: string;
  reference: string;
  label: string | null;
  scannedAt: string | null;
}

export interface ParcelList {
  parcels: Parcel[];
  scanned: number;
  total: number;
}

function parcelsCacheKey(jobId: string, stopId: string): string {
  return `parcels-${jobId}-${stopId}`;
}

/**
 * The parcel manifest for a stop. Network-first, then the last-synced manifest —
 * same pattern as the Today job list. Caching matters here specifically for the
 * scan counter: without a cached total, an offline stop would show "0/0
 * scanned" and a driver couldn't tell whether they'd scanned everything the
 * office loaded. The manifest is fetched (and cached) the moment a stop opens
 * online, so it's available if signal drops mid-round.
 */
export async function getStopParcels(jobId: string, stopId: string): Promise<ParcelList> {
  try {
    const { data } = await apiClient.get<ParcelList>(`/v1/jobs/${jobId}/stops/${stopId}/parcels`);
    await setCache(parcelsCacheKey(jobId, stopId), data);
    return data;
  } catch (err) {
    const cached = await getCache<ParcelList>(parcelsCacheKey(jobId, stopId));
    if (cached) return cached.data;
    throw err;
  }
}

/**
 * Scans a parcel. Offline (or on a network failure) the scan is queued to the
 * same outbox delivery completions use and replayed on reconnect — a scan in a
 * dead zone isn't lost. The server upserts by reference and is idempotent, so a
 * replayed scan can't double-count.
 */
export async function scanStopParcel(jobId: string, stopId: string, reference: string): Promise<{ queued: boolean }> {
  const url = `/v1/jobs/${jobId}/stops/${stopId}/parcels/scan`;
  const body = { reference };
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
