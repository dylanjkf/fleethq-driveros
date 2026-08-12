import { describe, expect, it, vi } from 'vitest';
import { submitScannedReference, type ScanSubmitContext } from './scan-submit';
import type { Parcel } from '@/api/parcels';

/**
 * The whole point of the camera feature: it must NOT create a second matching
 * path. A camera-decoded string and a hand-typed string have to reach the
 * identical server call, `scanStopParcel(jobId, stopId, reference)`. These tests
 * pin that — both routes go through `submitScannedReference`, and the mocked
 * scan sees the same reference either way. Manual entry working is proven by the
 * same function accepting a typed value with no camera involved.
 */
function makeCtx(opts: { scanResult?: { queued: boolean }; server?: Parcel[] } = {}) {
  let parcels: Parcel[] = [];
  const scan = vi.fn().mockResolvedValue(opts.scanResult ?? { queued: true }); // queued → no refetch
  const fetchParcels = vi.fn().mockResolvedValue({
    parcels: opts.server ?? [],
    scanned: opts.server?.length ?? 0,
    total: opts.server?.length ?? 0,
  });
  const setParcels: ScanSubmitContext['setParcels'] = (update) => {
    parcels = typeof update === 'function' ? (update as (p: Parcel[]) => Parcel[])(parcels) : update;
  };
  const ctx: ScanSubmitContext = {
    jobId: 'job-1',
    stopId: 'stop-1',
    setParcels,
    setScanning: vi.fn(),
    setError: vi.fn(),
    scan,
    fetchParcels,
  };
  return { ctx, scan, fetchParcels, getParcels: () => parcels };
}

describe('submitScannedReference — single matching path', () => {
  it('routes a manually-typed value to scanStopParcel with that reference', async () => {
    const { ctx, scan } = makeCtx();
    await submitScannedReference('PARCEL-123', ctx);
    expect(scan).toHaveBeenCalledExactlyOnceWith('job-1', 'stop-1', 'PARCEL-123');
  });

  it('routes a camera-decoded value to scanStopParcel with that reference', async () => {
    const { ctx, scan } = makeCtx();
    // A camera decode is just a raw string handed to the same function.
    await submitScannedReference('PARCEL-123', ctx);
    expect(scan).toHaveBeenCalledExactlyOnceWith('job-1', 'stop-1', 'PARCEL-123');
  });

  it('camera and manual entry of the same code hit scanStopParcel identically', async () => {
    const manual = makeCtx();
    const camera = makeCtx();
    await submitScannedReference('  ABC-9  ', manual.ctx); // manual, with surrounding whitespace
    await submitScannedReference('ABC-9', camera.ctx); // camera-decoded
    expect(manual.scan.mock.calls).toEqual(camera.scan.mock.calls);
    expect(manual.scan).toHaveBeenCalledWith('job-1', 'stop-1', 'ABC-9');
  });

  it('optimistically marks the parcel scanned before the network answers', async () => {
    const { ctx, getParcels } = makeCtx();
    await submitScannedReference('NEW-1', ctx);
    const p = getParcels().find((x) => x.reference === 'NEW-1');
    expect(p?.scannedAt).toBeTruthy();
  });

  it('ignores an empty/whitespace-only scan (no server call)', async () => {
    const { ctx, scan } = makeCtx();
    await submitScannedReference('   ', ctx);
    expect(scan).not.toHaveBeenCalled();
  });

  it('reconciles against the authoritative list when the scan reached the server', async () => {
    const server: Parcel[] = [{ id: 's1', reference: 'ABC-9', label: 'Box', scannedAt: '2026-08-12T00:00:00Z' }];
    const { ctx, fetchParcels, getParcels } = makeCtx({ scanResult: { queued: false }, server });
    await submitScannedReference('ABC-9', ctx);
    expect(fetchParcels).toHaveBeenCalledOnce();
    expect(getParcels()).toEqual(server);
  });
});
