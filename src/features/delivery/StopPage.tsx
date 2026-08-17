import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { applyStopOutcome, cacheStopOutcome, completeStop, type TodayJobs } from '@/api/jobs';
import { getActiveDeliveryFormTemplate } from '@/api/forms';
import { getStopParcels, type Parcel } from '@/api/parcels';
import { submitScannedReference } from './scan-submit';
import { scanBarcodeWithCamera } from '@/lib/barcode-scanner';
import { Button } from '@/components/ui/Button';
import { StatusBar } from '@/components/ui/StatusBar';
import { SignaturePad } from '@/components/ui/SignaturePad';
import { FormFields, isEmptyValue, visibleFieldsFor } from '@/features/forms/FormFields';
import { ApiClientError } from '@/api/client';
import { OutboxQuotaError } from '@/lib/offline-db';
import { compressImageFile, MAX_PHOTO_BYTES } from '@/lib/image';
import { directionsUrl } from '@/lib/maps';
import type { FormAnswer, StopFailureReason, StopOutcome } from '@/api/types';

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
  // Answers for the configurable POD evidence form (when a DELIVERY template
  // is active). Independent of the legacy hardcoded photo/signature state above.
  const [evidenceAnswers, setEvidenceAnswers] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  // The tenant's configurable proof-of-delivery evidence set, if configured.
  // `null`/undefined → fall back to the legacy hardcoded photo + signature.
  const { data: deliveryTemplate } = useQuery({
    queryKey: ['delivery-template'],
    queryFn: getActiveDeliveryFormTemplate,
    staleTime: 60_000,
  });

  const [parcels, setParcels] = useState<Parcel[]>([]);
  // Explicit acknowledgement that a DELIVERED stop is going out with one or more
  // parcels that were never scanned/confirmed (multi-drop guard). Nothing is
  // delivered unconfirmed *silently*: the server records who/when/what on this
  // override (pod_unconfirmed_override), same contract as the load-verification
  // discrepancy override.
  const [overrideUnconfirmed, setOverrideUnconfirmed] = useState(false);
  const [scanInput, setScanInput] = useState('');
  const [scanning, setScanning] = useState(false);
  // Non-blocking status for the camera scanner (permission denied, no-read,
  // etc.). Kept separate from `error` so it shows next to the scan controls
  // without disturbing the delivery form — manual entry stays available.
  const [scanMessage, setScanMessage] = useState<string | null>(null);

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

  // Resolve any raw scanned string — from the manual input OR the camera —
  // through the ONE shared matching path (see scan-submit.ts / scanStopParcel).
  async function resolveScan(raw: string) {
    if (!jobId || !stopId) return;
    await submitScannedReference(raw, { jobId, stopId, setParcels, setScanning, setError });
  }

  async function onScan(e: FormEvent) {
    e.preventDefault();
    const raw = scanInput;
    setScanInput('');
    await resolveScan(raw);
  }

  async function onCameraScan() {
    setScanMessage(null);
    const result = await scanBarcodeWithCamera();
    if (result.ok) {
      await resolveScan(result.value);
    } else if (result.message) {
      // permission / unsupported / no-read: tell the driver, keep manual entry.
      setScanMessage(result.message);
    }
    // 'cancelled' (empty message) → driver backed out; say nothing.
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

  // The POD evidence form's currently-visible fields (empty when no template).
  const evidenceFields = deliveryTemplate ? visibleFieldsFor(deliveryTemplate.fields, evidenceAnswers) : [];
  // Every parcel at the stop rides on this completion (multi-drop: one shared
  // capture covers them all — the common 1–3 parcel case). Omitting parcelIds
  // would mean the same thing server-side; we send them explicitly.
  const parcelIds = parcels.length > 0 ? parcels.map((p) => p.id) : undefined;

  function setEvidenceValue(fieldId: string, value: unknown) {
    setEvidenceAnswers((prev) => ({ ...prev, [fieldId]: value }));
    setError(null);
  }

  async function submit() {
    if (!jobId || !stopId || !outcome) return;
    if (outcome === 'FAILED' && !note.trim()) {
      setError('Add a note explaining why the delivery failed.');
      return;
    }

    // Configurable POD: when a DELIVERY template is active, a DELIVERED drop
    // captures its evidence instead of the hardcoded photo/signature. Enforce
    // required fields client-side (the server is the real gate).
    let evidence: { id: string; answers: FormAnswer[] } | undefined;
    if (deliveryTemplate && outcome === 'DELIVERED') {
      for (const field of evidenceFields) {
        if (field.required && isEmptyValue(evidenceAnswers[field.id])) {
          setError(`Capture "${field.label}" before saving this delivery.`);
          return;
        }
      }
      evidence = {
        id: crypto.randomUUID(),
        answers: evidenceFields
          .filter((f) => !isEmptyValue(evidenceAnswers[f.id]))
          .map((f) => ({ fieldId: f.id, value: evidenceAnswers[f.id] })),
      };
    }

    // Multi-drop guard: a DELIVERED stop must not go out with parcels that were
    // never scanned/confirmed unless the driver explicitly overrides. Block the
    // submit until every parcel is scanned OR the override below is ticked — the
    // server then records the unconfirmed set (who/when/what).
    const unscanned = parcels.filter((p) => !p.scannedAt);
    if (outcome === 'DELIVERED' && unscanned.length > 0 && !overrideUnconfirmed) {
      setError(
        `${unscanned.length} parcel${unscanned.length === 1 ? '' : 's'} not scanned. Scan ${unscanned.length === 1 ? 'it' : 'them'}, or tick "Deliver unscanned" to proceed — it's recorded.`,
      );
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
        // Legacy hardcoded POD only when NO configurable template is set — the
        // backend still supports this path for backward compatibility.
        ...(deliveryTemplate
          ? {}
          : {
              podPhotoBase64: photo?.dataUrl,
              podPhotoContentType: photo?.contentType,
              podPhotoFilename: photo?.filename,
              signatureBase64: signatureDataUrl ?? undefined,
              signatureContentType: signatureDataUrl ? 'image/png' : undefined,
              signatureFilename: signatureDataUrl ? 'signature.png' : undefined,
            }),
        ...(parcelIds ? { parcelIds } : {}),
        ...(evidence ? { evidence } : {}),
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

          <div className="space-y-2">
            {/* Manual entry — HID/Bluetooth scanner or typed by hand. ALWAYS
                available, never hidden behind an error state. */}
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
            {/* Camera scan — same matching path as the manual input above. */}
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

          {deliveryTemplate ? (
            // Configurable proof-of-delivery: capture the tenant's DELIVERY
            // template evidence on a delivered drop (one shared capture covers
            // every parcel at the stop). Nothing extra to capture on a failure.
            outcome === 'DELIVERED' && (
              <div className="space-y-4">
                <div>
                  <span className="block text-sm font-semibold">Delivery evidence</span>
                  {deliveryTemplate.description && (
                    <span className="block text-sm text-(--text-tertiary)">{deliveryTemplate.description}</span>
                  )}
                  {parcels.length > 1 && (
                    <span className="block text-sm text-(--text-tertiary)">Covers all {parcels.length} parcels at this stop.</span>
                  )}
                </div>
                <FormFields fields={evidenceFields} answers={evidenceAnswers} onChange={setEvidenceValue} assetName={null} operatorName={null} />
              </div>
            )
          ) : (
            <>
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
            </>
          )}

          {outcome === 'DELIVERED' && parcels.some((p) => !p.scannedAt) && (
            <label className="flex items-start gap-3 rounded-2xl border border-warning-500/40 bg-warning-500/10 p-4 text-sm">
              <input
                type="checkbox"
                checked={overrideUnconfirmed}
                onChange={(e) => {
                  setOverrideUnconfirmed(e.target.checked);
                  setError(null);
                }}
                className="mt-1 size-5 shrink-0"
              />
              <span>
                Deliver unscanned — {parcels.filter((p) => !p.scannedAt).length} parcel
                {parcels.filter((p) => !p.scannedAt).length === 1 ? '' : 's'} not scanned. Proceeding is recorded against this run.
              </span>
            </label>
          )}

          {error && <p className="text-danger-500">{error}</p>}
          <Button onClick={submit} disabled={!outcome || submitting}>
            {submitting ? 'Saving…' : 'Save delivery'}
          </Button>
        </div>
      )}
    </div>
  );
}
