import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { getLoadStatus, verifyLoad, cacheLoadStatus, type LoadStatus } from '@/api/load';
import { submitScannedReference } from './scan-submit';
import { scanBarcodeWithCamera } from '@/lib/barcode-scanner';
import { Button } from '@/components/ui/Button';
import { StatusBar } from '@/components/ui/StatusBar';
import { ApiClientError } from '@/api/client';
import { OutboxQuotaError } from '@/lib/offline-db';
import type { Parcel } from '@/api/parcels';

/** Unscanned parcels across every stop — the live discrepancy set, recomputed
 *  from status so it stays correct after an optimistic scan/mark. */
function missingParcels(status: LoadStatus | null) {
  if (!status) return [];
  return status.stops.flatMap((s) =>
    s.parcels.filter((p) => !p.scannedAt).map((p) => ({ stopId: s.stopId, stopLabel: s.label, reference: p.reference })),
  );
}

/** Optimistically mark a reference scanned within the aggregated load status. */
function markInStatus(status: LoadStatus, reference: string): LoadStatus {
  const now = new Date().toISOString();
  const stops = status.stops.map((s) => ({
    ...s,
    parcels: s.parcels.map((p) => (p.reference === reference ? { ...p, scannedAt: p.scannedAt ?? now } : p)),
    scannedCount: s.parcels.filter((p) => p.scannedAt || p.reference === reference).length,
  }));
  return { ...status, stops, scannedTotal: stops.reduce((n, s) => n + s.scannedCount, 0) };
}

/**
 * "Confirm load" (item 2): before starting a run, the driver checks what's
 * physically on the vehicle against the run's expected manifest — the aggregate
 * of its stops' parcels. They scan each item (or mark it loaded), and the screen
 * surfaces any manifest item not yet scanned/confirmed as a discrepancy. A clean
 * load confirms and starts; a discrepancy requires an explicit "Proceed anyway",
 * which records the override (who/when/what was missing) on the API. Scanning and
 * "mark loaded" both go through the ONE shared scan path (submitScannedReference
 * → the per-stop scan endpoint) — no second matcher.
 */
export function ConfirmLoadPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const jobId = params.get('jobId');
  const jobTitle = params.get('title');

  const [status, setStatus] = useState<LoadStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const [scanInput, setScanInput] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);

  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  useEffect(() => {
    if (!jobId) return;
    let active = true;
    getLoadStatus(jobId)
      .then((s) => active && setStatus(s))
      .catch(() => active && setLoadError(true))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [jobId]);

  const missing = missingParcels(status);
  const hasDiscrepancy = missing.length > 0;

  // Route a scanned/typed/marked reference to the stop that owns it, through the
  // SHARED scan path. An unknown reference (not on this run's manifest) can't be
  // placed on a stop here, so we tell the driver rather than guess.
  async function resolveReference(raw: string) {
    const reference = raw.trim();
    if (!reference || !jobId || !status) return;
    const stop = status.stops.find((s) => s.parcels.some((p) => p.reference === reference));
    if (!stop) {
      setScanMessage(`"${reference}" isn't on this run's manifest.`);
      return;
    }
    setScanMessage(null);
    const optimistic = markInStatus(status, reference);
    setStatus(optimistic);
    // Persist the optimistic scan to the offline cache BEFORE anything else, so
    // it survives an app restart in a dead zone. Without this, a scan lives only
    // in React state + the replay outbox, and a restart while offline reloads
    // the pre-scan server status — the parcel would wrongly reappear as missing.
    // Mirrors StopPage's cacheStopOutcome.
    await cacheLoadStatus(optimistic);
    // Reuse the one server matching path (scanStopParcel → …/parcels/scan). The
    // per-stop setParcels is a no-op here — we reconcile the aggregate below.
    await submitScannedReference(reference, {
      jobId,
      stopId: stop.stopId,
      setParcels: (() => {}) as unknown as (u: Parcel[] | ((p: Parcel[]) => Parcel[])) => void,
      setScanning,
      setError: (m) => setError(m),
    });
    // Reconcile against the authoritative aggregate when online (getLoadStatus
    // re-caches it); offline this throws and we keep the optimistic mark, which
    // is already persisted above.
    try {
      setStatus(await getLoadStatus(jobId));
    } catch {
      /* offline — keep optimistic state (already cached) */
    }
  }

  async function onScanSubmit(e: FormEvent) {
    e.preventDefault();
    const raw = scanInput;
    setScanInput('');
    await resolveReference(raw);
  }

  async function onCameraScan() {
    setScanMessage(null);
    const result = await scanBarcodeWithCamera();
    if (result.ok) await resolveReference(result.value);
    else if (result.message) setScanMessage(result.message);
  }

  async function verify(override: boolean) {
    if (!jobId) return;
    setError(null);
    setVerifying(true);
    try {
      const result = await verifyLoad(jobId, {
        confirm: true,
        override: override || undefined,
        missingReferences: override ? missing.map((m) => m.reference) : undefined,
      });
      if (!result.queued) {
        await queryClient.invalidateQueries({ queryKey: ['today-jobs'] });
      }
      setConfirmation(
        result.queued
          ? "Load confirmed — it'll sync when you're back online."
          : override
            ? 'Load verified with the discrepancy recorded.'
            : 'Load verified. You’re good to go.',
      );
      setTimeout(() => navigate('/'), 1400);
    } catch (err) {
      // A quota failure means the verification was NOT saved — say so plainly.
      if (err instanceof OutboxQuotaError) setError(err.message);
      // The server itself refused a partial load without override — surface it;
      // the driver can then use "Proceed anyway".
      else if (err instanceof ApiClientError && err.code === 'LOAD_DISCREPANCY')
        setError('Some parcels still aren’t confirmed loaded. Scan them, or use "Proceed anyway".');
      else setError(err instanceof ApiClientError ? err.message : 'Could not confirm the load. Try again.');
    } finally {
      setVerifying(false);
    }
  }

  if (!jobId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-(--text-secondary)">Open Confirm load from a job on Today.</p>
        <Button variant="secondary" onClick={() => navigate('/')}>Back to Today</Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="px-6 py-5">
        <button className="mb-2 text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>← Back</button>
        <h1 className="text-2xl font-bold">Confirm load</h1>
        {jobTitle && <p className="text-(--text-secondary)">{jobTitle}</p>}
        <p className="text-(--text-tertiary)">Check everything on the manifest is on the vehicle before you start.</p>
      </div>

      {confirmation ? (
        <p className="px-6 text-lg text-success-500">{confirmation}</p>
      ) : loading ? (
        <p className="px-6 text-(--text-secondary)">Loading manifest…</p>
      ) : loadError && !status ? (
        <p className="px-6 text-danger-500">Couldn’t load the manifest. Check your connection.</p>
      ) : status && status.expectedTotal === 0 ? (
        <div className="flex-1 space-y-4 px-6 pb-8">
          <p className="text-(--text-secondary)">This run has no parcels on its manifest — nothing to verify.</p>
          <Button onClick={() => void verify(false)} disabled={verifying}>
            {verifying ? 'Confirming…' : 'Confirm & start'}
          </Button>
          {error && <p className="text-danger-500">{error}</p>}
        </div>
      ) : (
        status && (
          <div className="flex-1 space-y-4 px-6 pb-8">
            <div className="flex items-center justify-between rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
              <span className="text-sm font-semibold">Loaded</span>
              <span className={`text-sm font-semibold ${hasDiscrepancy ? 'text-warning-500' : 'text-success-500'}`}>
                {status.scannedTotal}/{status.expectedTotal} confirmed
              </span>
            </div>

            {/* Scan controls — same shared matching path as the delivery screen. */}
            <div className="space-y-2">
              <form onSubmit={onScanSubmit} className="flex gap-2">
                <input
                  className="min-h-14 flex-1 rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
                  placeholder="Scan or enter parcel barcode"
                  value={scanInput}
                  onChange={(e) => setScanInput(e.target.value)}
                  autoComplete="off"
                  inputMode="text"
                />
                <button type="submit" disabled={scanning || !scanInput.trim()} className="min-h-14 rounded-2xl bg-accent-600 px-5 text-sm font-semibold text-white disabled:opacity-50">
                  {scanning ? '…' : 'Scan'}
                </button>
              </form>
              <button
                type="button"
                onClick={() => void onCameraScan()}
                disabled={scanning}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-accent-500/40 bg-accent-500/5 text-sm font-semibold text-accent-500 disabled:opacity-50"
              >
                Scan with camera
              </button>
              {scanMessage && <p className="text-sm text-(--text-tertiary)">{scanMessage}</p>}
            </div>

            {/* The manifest, grouped by stop, each item with its loaded state and
                a "Mark loaded" that reuses the same scan path. */}
            {status.stops.map((stop) => (
              <div key={stop.stopId} className="space-y-2 rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold">{stop.label}</span>
                  <span className={`text-sm ${stop.scannedCount === stop.expectedCount ? 'text-success-500' : 'text-(--text-tertiary)'}`}>
                    {stop.scannedCount}/{stop.expectedCount}
                  </span>
                </div>
                {stop.parcels.length === 0 ? (
                  <p className="text-sm text-(--text-tertiary)">No parcels listed.</p>
                ) : (
                  stop.parcels.map((p) => (
                    <div key={p.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate">{p.reference}</span>
                      {p.scannedAt ? (
                        <span className="font-semibold text-success-500">✓ Loaded</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void resolveReference(p.reference)}
                          disabled={scanning}
                          className="shrink-0 rounded-full border border-accent-500/40 bg-accent-500/5 px-3 py-1 text-sm font-semibold text-accent-500 disabled:opacity-50"
                        >
                          Mark loaded
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            ))}

            {hasDiscrepancy ? (
              <div className="space-y-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4">
                <p className="text-sm font-semibold text-warning-500">
                  {missing.length} item{missing.length === 1 ? '' : 's'} not confirmed loaded
                </p>
                <ul className="space-y-1 text-sm text-(--text-secondary)">
                  {missing.map((m) => (
                    <li key={`${m.stopId}-${m.reference}`}>
                      {m.reference} <span className="text-(--text-tertiary)">· {m.stopLabel}</span>
                    </li>
                  ))}
                </ul>
                <p className="text-sm text-(--text-tertiary)">
                  Scan or mark them loaded, or proceed anyway — proceeding is recorded against this run.
                </p>
                <Button variant="secondary" onClick={() => void verify(true)} disabled={verifying}>
                  {verifying ? 'Recording…' : 'Proceed anyway'}
                </Button>
              </div>
            ) : (
              <Button onClick={() => void verify(false)} disabled={verifying}>
                {verifying ? 'Confirming…' : 'Confirm load & start'}
              </Button>
            )}

            {error && <p className="text-danger-500">{error}</p>}
            {status.loadVerifiedAt && !confirmation && (
              <p className="text-sm text-success-500">Already verified {new Date(status.loadVerifiedAt).toLocaleString()}.</p>
            )}
          </div>
        )
      )}
    </div>
  );
}
