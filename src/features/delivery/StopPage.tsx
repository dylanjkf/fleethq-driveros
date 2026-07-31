import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { applyStopOutcome, cacheStopOutcome, completeStop, type TodayJobs } from '@/api/jobs';
import { getStopParcels, scanStopParcel, type Parcel } from '@/api/parcels';
import { Button } from '@/components/ui/Button';
import { StatusBar } from '@/components/ui/StatusBar';
import { SignaturePad } from '@/components/ui/SignaturePad';
import { ApiClientError } from '@/api/client';
import { OutboxQuotaError } from '@/lib/offline-db';
import { compressImageFile } from '@/lib/image';
import { directionsUrl } from '@/lib/maps';
import type { StopFailureReason, StopOutcome } from '@/api/types';

/** Client-side ceiling, comfortably under the server's 8 MB decoded cap even
 *  after base64 — a safety net; compression keeps real photos far below this. */
const MAX_PHOTO_BYTES = 7_500_000;

type Outcome = Exclude<StopOutcome, 'PENDING'>;

const FAILURE_REASONS: { value: StopFailureReason; label: string }[] = [
  { value: 'NOBODY_HOME', label: 'Nobody home' },
  { value: 'ACCESS_DENIED', label: 'Access denied' },
  { value: 'BUSINESS_CLOSED', label: 'Business closed' },
  { value: 'ADDRESS_ISSUE', label: 'Address issue' },
  { value: 'REFUSED', label: 'Refused' },
  { value: 'OTHER', label: 'Other' },
];

/**
 * Proof of Delivery on DriverOS: the operator records the outcome of a delivery
 * stop — delivered or attempted-failed — with a recipient name, a note, and an
 * optional photo, captured from the tablet camera. Works offline: the whole
 * completion (photo included, as base64) queues to the outbox and syncs on
 * reconnect. Internal capture for the fleet's records — not customer-facing.
 */
export function StopPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const jobId = params.get('jobId');
  const stopId = params.get('stopId');
  const label = params.get('label');
  const address = params.get('address');
  const windowEnd = params.get('windowEnd');

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');
  const [failureReason, setFailureReason] = useState<StopFailureReason | null>(null);
  const [photo, setPhoto] = useState<{ dataUrl: string; contentType: string; filename: string } | null>(null);
  const [signatureDataUrl, setSignatureDataUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  const [parcels, setParcels] = useState<Parcel[]>([]);
  const [scanInput, setScanInput] = useState('');
  const [scanning, setScanning] = useState(false);

  // Load any parcels the office pre-listed for this stop. Best-effort: offline
  // (or a stop with no parcels) simply shows the section empty — parcels are an
  // optional layer on top of the delivery, never a blocker.
  useEffect(() => {
    if (!jobId || !stopId) return;
    let active = true;
    getStopParcels(jobId, stopId)
      .then((res) => active && setParcels(res.parcels))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [jobId, stopId]);

  const scannedCount = parcels.filter((p) => p.scannedAt).length;

  async function onScan(e: FormEvent) {
    e.preventDefault();
    const reference = scanInput.trim();
    if (!reference || !jobId || !stopId) return;
    setScanning(true);
    // Optimistic: reflect the scan immediately so a fast scanner keeps up.
    setParcels((prev) => {
      const existing = prev.find((p) => p.reference === reference);
      if (existing) return prev.map((p) => (p.reference === reference ? { ...p, scannedAt: p.scannedAt ?? new Date().toISOString() } : p));
      return [...prev, { id: `local-${reference}`, reference, label: null, scannedAt: new Date().toISOString() }];
    });
    setScanInput('');
    try {
      const { queued } = await scanStopParcel(jobId, stopId, reference);
      // When it reached the server, reconcile with the authoritative list.
      if (!queued) {
        const res = await getStopParcels(jobId, stopId);
        setParcels(res.parcels);
      }
    } catch {
      // Leave the optimistic state; the outbox (if queued) or a later reload fixes it.
    } finally {
      setScanning(false);
    }
  }

  async function onPickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      // Downscale before it ever hits state or the outbox — keeps the POD
      // legible but small enough to never trip the server's 8 MB cap (which,
      // offline, would only surface as a poisoned queue item on replay).
      const compressed = await compressImageFile(file);
      if (compressed.bytes > MAX_PHOTO_BYTES) {
        setError('That photo is too large to attach even after compression. Try a lower-resolution shot.');
        return;
      }
      setPhoto({ dataUrl: compressed.dataUrl, contentType: compressed.contentType, filename: compressed.filename });
    } catch {
      setError('Could not process that photo. Try again.');
    }
  }

  async function submit() {
    if (!jobId || !stopId || !outcome) return;
    if (outcome === 'FAILED' && !note.trim()) {
      setError('Add a note explaining why the delivery failed.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await completeStop(jobId, stopId, {
        outcome,
        recipientName: recipient.trim() || undefined,
        note: note.trim() || undefined,
        failureReason: outcome === 'FAILED' ? (failureReason ?? undefined) : undefined,
        // Stamped now so an offline delivery keeps its real time, not sync time.
        occurredAt: new Date().toISOString(),
        podPhotoBase64: photo?.dataUrl,
        podPhotoContentType: photo?.contentType,
        podPhotoFilename: photo?.filename,
        signatureBase64: signatureDataUrl ?? undefined,
        signatureContentType: signatureDataUrl ? 'image/png' : undefined,
        signatureFilename: signatureDataUrl ? 'signature.png' : undefined,
      });
      // Reflect the completed stop everywhere the driver might see it next,
      // *including offline* where a refetch can't: update the live query data and
      // persist the same change to the offline cache. Without this, a stop just
      // completed in a dead zone still shows "Deliver →" for the rest of the run.
      queryClient.setQueriesData<TodayJobs>({ queryKey: ['today-jobs'] }, (old) =>
        old ? { ...old, items: applyStopOutcome(old.items, jobId, stopId, outcome) } : old,
      );
      await cacheStopOutcome(jobId, stopId, outcome);
      // When online, also reconcile against the server's authoritative version.
      if (!result.queued) await queryClient.invalidateQueries({ queryKey: ['today-jobs'] });
      setConfirmation(result.queued ? "Saved — it'll sync when you're back online." : 'Delivery recorded.');
      setTimeout(() => navigate('/'), 1400);
    } catch (err) {
      // A quota failure means the delivery was NOT saved — say so plainly and
      // keep the driver on the page (no navigate) so nothing is silently lost.
      if (err instanceof OutboxQuotaError) setError(err.message);
      else setError(err instanceof ApiClientError ? err.message : 'Could not save. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!jobId || !stopId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-(--text-secondary)">Open a stop from Today to record its delivery.</p>
        <Button variant="secondary" onClick={() => navigate('/')}>Back to Today</Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="px-6 py-5">
        <button className="mb-2 text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>← Back</button>
        <h1 className="text-2xl font-bold">Record delivery</h1>
        {label && <p className="text-(--text-secondary)">{label}</p>}
        {address && <p className="text-(--text-tertiary)">{address}</p>}
        {windowEnd && (
          <p className={`text-sm ${new Date(windowEnd) < new Date() ? 'text-danger-500' : 'text-(--text-tertiary)'}`}>
            Due by {new Date(windowEnd).toLocaleString()}
          </p>
        )}
        {address && (
          <a
            href={directionsUrl(address)}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 flex min-h-12 items-center justify-center rounded-2xl border border-accent-500/40 bg-accent-500/5 text-sm font-semibold text-accent-500"
          >
            Navigate to this stop ↗
          </a>
        )}
      </div>

      {confirmation ? (
        <p className="px-6 text-lg text-success-500">{confirmation}</p>
      ) : (
        <div className="flex-1 space-y-4 px-6 pb-8">
          {(parcels.length > 0 || scanInput) && (
            <div className="space-y-2 rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Parcels</span>
                {parcels.length > 0 && (
                  <span className={`text-sm ${scannedCount === parcels.length ? 'text-success-500' : 'text-(--text-tertiary)'}`}>
                    {scannedCount}/{parcels.length} scanned
                  </span>
                )}
              </div>
              {parcels.map((p) => (
                <div key={p.id} className="flex items-center justify-between text-sm">
                  <span>
                    {p.reference}
                    {p.label && <span className="text-(--text-tertiary)"> · {p.label}</span>}
                  </span>
                  <span className={p.scannedAt ? 'font-semibold text-success-500' : 'text-(--text-tertiary)'}>{p.scannedAt ? '✓ Scanned' : 'Pending'}</span>
                </div>
              ))}
            </div>
          )}

          <form onSubmit={onScan} className="flex gap-2">
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

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setOutcome('DELIVERED')}
              className={`min-h-14 flex-1 rounded-2xl text-lg font-semibold ${outcome === 'DELIVERED' ? 'bg-success-500 text-white' : 'bg-(--surface-1) text-(--text-secondary)'}`}
            >
              Delivered
            </button>
            <button
              type="button"
              onClick={() => setOutcome('FAILED')}
              className={`min-h-14 flex-1 rounded-2xl text-lg font-semibold ${outcome === 'FAILED' ? 'bg-danger-500 text-white' : 'bg-(--surface-1) text-(--text-secondary)'}`}
            >
              Couldn't deliver
            </button>
          </div>

          {outcome === 'FAILED' && (
            <div className="flex flex-wrap gap-2">
              {FAILURE_REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  onClick={() => setFailureReason(r.value)}
                  className={`rounded-full px-3 py-2 text-sm font-medium ${failureReason === r.value ? 'bg-danger-500 text-white' : 'bg-(--surface-1) text-(--text-secondary)'}`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}

          <input
            className="min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
            placeholder="Received by (name)"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
          <textarea
            className="min-h-20 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 py-3 text-lg"
            placeholder={outcome === 'FAILED' ? 'What happened? (required)' : 'Note (optional)'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <label className="block">
            <span className="mb-2 block text-sm text-(--text-tertiary)">Proof photo (optional)</span>
            {photo ? (
              <div className="relative">
                <img src={photo.dataUrl} alt="Proof of delivery" className="w-full rounded-2xl border border-(--border-subtle)" />
                <button type="button" onClick={() => setPhoto(null)} className="absolute right-2 top-2 rounded-full bg-(--surface-0)/80 px-3 py-1 text-sm">Retake</button>
              </div>
            ) : (
              <span className="flex min-h-14 items-center justify-center rounded-2xl border border-dashed border-(--border-subtle) bg-(--surface-1) text-(--text-secondary)">
                Tap to take a photo
              </span>
            )}
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onPickPhoto(e)} />
          </label>

          <div>
            <span className="mb-2 block text-sm text-(--text-tertiary)">Recipient signature (optional)</span>
            <SignaturePad onChange={setSignatureDataUrl} />
          </div>

          {error && <p className="text-danger-500">{error}</p>}
          <Button onClick={submit} disabled={!outcome || submitting}>
            {submitting ? 'Saving…' : 'Save delivery'}
          </Button>
        </div>
      )}
    </div>
  );
}
