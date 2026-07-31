import { apiClient } from './client';

export interface LocationFix {
  lat: number;
  lng: number;
  accuracyM?: number;
}

/**
 * Reports the operator's current position so the office dispatch board can see
 * "where is my driver now" (05-Dispatch/Dispatch_Overview.md). Best-effort and
 * deliberately NOT queued to the offline outbox: a stale position replayed
 * minutes later would be worse than none — it would plot the driver where they
 * used to be. Callers swallow failures; the next heartbeat tries again.
 */
export async function reportLocation(fix: LocationFix): Promise<void> {
  await apiClient.post('/v1/locations', fix);
}
