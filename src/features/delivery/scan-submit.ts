import type { Dispatch, SetStateAction } from 'react';
import { getStopParcels, scanStopParcel, type Parcel } from '@/api/parcels';
import { OutboxQuotaError } from '@/lib/offline-db';

/**
 * The single scan-resolution path for a stop. BOTH the manual barcode text
 * input (HID/Bluetooth scanner or typed by hand) AND the camera scanner funnel
 * a raw scanned string through here, so there is exactly one server-side
 * matching path (`scanStopParcel` → POST …/parcels/scan). Adding a second entry
 * point (the camera) must never mean a second matching path — hence this shared
 * function.
 *
 * The steps are the ones the old inline `onScan` did, unchanged in behaviour:
 * trim → optimistic mark → `scanStopParcel` (offline-capable via postOrQueue) →
 * reconcile against the authoritative list when it actually reached the server.
 */
export interface ScanSubmitContext {
  jobId: string;
  stopId: string;
  setParcels: Dispatch<SetStateAction<Parcel[]>>;
  setScanning: (scanning: boolean) => void;
  setError: (message: string) => void;
  /** Injectable for tests; defaults to the real API. */
  scan?: typeof scanStopParcel;
  /** Injectable for tests; defaults to the real API. */
  fetchParcels?: typeof getStopParcels;
}

/**
 * Optimistically reflect a scan in the parcel list so a fast scanner (or a
 * camera burst) keeps up before the network answers. Pure — safe for React
 * setState. Marks an already-listed parcel scanned, or appends a `local-…`
 * placeholder the reconcile step later replaces with the server's row.
 */
export function markScanned(prev: Parcel[], reference: string): Parcel[] {
  const existing = prev.find((p) => p.reference === reference);
  if (existing) {
    return prev.map((p) =>
      p.reference === reference ? { ...p, scannedAt: p.scannedAt ?? new Date().toISOString() } : p,
    );
  }
  return [...prev, { id: `local-${reference}`, reference, label: null, scannedAt: new Date().toISOString() }];
}

export async function submitScannedReference(raw: string, ctx: ScanSubmitContext): Promise<void> {
  const reference = raw.trim();
  if (!reference) return;
  const scan = ctx.scan ?? scanStopParcel;
  const fetchParcels = ctx.fetchParcels ?? getStopParcels;

  ctx.setScanning(true);
  ctx.setParcels((prev) => markScanned(prev, reference));
  try {
    const { queued } = await scan(ctx.jobId, ctx.stopId, reference);
    // When it reached the server, reconcile with the authoritative list
    // (an unknown reference the server rejected simply won't appear).
    if (!queued) {
      const res = await fetchParcels(ctx.jobId, ctx.stopId);
      ctx.setParcels(res.parcels);
    }
  } catch (err) {
    // A quota failure means the scan was NOT queued — surface it so the driver
    // knows the outbox is full, rather than swallowing it silently. Other
    // errors leave the optimistic state; the outbox or a later reload fixes it.
    if (err instanceof OutboxQuotaError) ctx.setError(err.message);
  } finally {
    ctx.setScanning(false);
  }
}
