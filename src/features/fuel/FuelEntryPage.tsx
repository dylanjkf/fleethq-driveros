import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { recordFuelEntry } from '@/api/fuel';
import { ApiClientError } from '@/api/client';
import { compressImageFile } from '@/lib/image';
import { Button } from '@/components/ui/Button';
import { StatusBar } from '@/components/ui/StatusBar';

/** Same ceiling the POD photo uses — a safety net above compression. */
const MAX_PHOTO_BYTES = 7_500_000;

/**
 * Record a fuel-card purchase. Captures exactly what the office needs to
 * reconcile a fuel-card statement against the fleet: **odometer** (so fuel
 * economy is computable), a **photo of the receipt**, the **last 4 digits of the
 * card used**, and the **licence plate** on the receipt.
 *
 * Two deliberate choices:
 *  - **Only 4 card digits are accepted**, enforced by `maxLength`/`inputMode` here
 *    and again by the API and a database CHECK. A driver cannot accidentally type
 *    a full card number into FleetOS.
 *  - **Offline-first**, like POD: drivers fuel up at truck stops with no signal,
 *    so the entry (receipt photo included) queues and syncs later, stamped with
 *    the time the tank was actually filled.
 */
export function FuelEntryPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Pre-filled when opened from an assigned job, so the plate/asset are right.
  const assetId = searchParams.get('assetId') ?? undefined;
  const assetName = searchParams.get('assetName');
  const [licencePlate, setLicencePlate] = useState(searchParams.get('registration') ?? '');

  const [odometer, setOdometer] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [litres, setLitres] = useState('');
  const [totalCost, setTotalCost] = useState('');
  const [notes, setNotes] = useState('');
  const [receipt, setReceipt] = useState<{ dataUrl: string; contentType: string; filename: string } | null>(null);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  async function onPickReceipt(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFormError(null);
    try {
      // Downscale before it reaches state or the outbox — a queued oversized
      // photo would only fail later, on replay, which is the worst time to find out.
      const compressed = await compressImageFile(file);
      if (compressed.bytes > MAX_PHOTO_BYTES) {
        setFormError('That photo is too large even after compression. Try a lower-resolution shot.');
        return;
      }
      setReceipt({ dataUrl: compressed.dataUrl, contentType: compressed.contentType, filename: compressed.filename });
    } catch {
      setFormError('Could not process that photo. Try again.');
    }
  }

  const odometerValue = Number.parseInt(odometer, 10);
  const canSubmit =
    Number.isFinite(odometerValue) && odometerValue >= 0 && licencePlate.trim().length > 0 && /^\d{4}$/.test(cardLast4);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setFormError(null);
    setIsSubmitting(true);
    try {
      const result = await recordFuelEntry({
        assetId,
        odometerReading: odometerValue,
        licencePlate: licencePlate.trim(),
        cardLast4,
        litres: litres.trim() ? Number(litres) : undefined,
        totalCost: totalCost.trim() ? Number(totalCost) : undefined,
        notes: notes.trim() || undefined,
        // Stamped now so an offline entry keeps the real fill time, not sync time.
        filledAt: new Date().toISOString(),
        receiptBase64: receipt?.dataUrl,
        receiptFilename: receipt?.filename,
        receiptContentType: receipt?.contentType,
      });
      setConfirmation(
        result.queued
          ? "Saved on this device — it'll sync automatically once you're back online."
          : 'Fuel purchase recorded.',
      );
      setTimeout(() => navigate('/'), 1500);
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'Could not submit. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="px-6 py-5">
        <button className="mb-2 text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>
          ← Back
        </button>
        <h1 className="text-2xl font-bold">Record fuel</h1>
        {assetName && <p className="text-(--text-secondary)">{assetName}</p>}
      </div>

      {confirmation ? (
        <p className="px-6 text-lg text-success-500">{confirmation}</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex-1 space-y-4 px-6 pb-8">
          <label className="block">
            <span className="text-sm text-(--text-secondary)">Odometer reading</span>
            <input
              className="mt-1 min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
              inputMode="numeric"
              placeholder="e.g. 184320"
              autoFocus
              value={odometer}
              onChange={(e) => setOdometer(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </label>

          <label className="block">
            <span className="text-sm text-(--text-secondary)">Licence plate on the receipt</span>
            <input
              className="mt-1 min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg uppercase"
              placeholder="e.g. ABC123"
              value={licencePlate}
              onChange={(e) => setLicencePlate(e.target.value)}
            />
          </label>

          <label className="block">
            <span className="text-sm text-(--text-secondary)">Last 4 digits of the card</span>
            <input
              className="mt-1 min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
              inputMode="numeric"
              // Four digits only, by construction — never the full card number.
              maxLength={4}
              placeholder="e.g. 4321"
              value={cardLast4}
              onChange={(e) => setCardLast4(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
            />
            <span className="mt-1 block text-xs text-(--text-tertiary)">
              Only the last 4 — never enter the full card number.
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm text-(--text-secondary)">Litres (optional)</span>
              <input
                className="mt-1 min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
                inputMode="decimal"
                placeholder="92.5"
                value={litres}
                onChange={(e) => setLitres(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-sm text-(--text-secondary)">Total cost (optional)</span>
              <input
                className="mt-1 min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
                inputMode="decimal"
                placeholder="178.40"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
              />
            </label>
          </div>

          <div>
            <span className="text-sm text-(--text-secondary)">Photo of the receipt</span>
            <label className="mt-1 flex min-h-14 cursor-pointer items-center justify-center rounded-2xl border border-dashed border-(--border-subtle) bg-(--surface-1) px-4 text-lg">
              {receipt ? 'Receipt attached — tap to replace' : 'Take a photo of the receipt'}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={(e) => void onPickReceipt(e)}
              />
            </label>
            {receipt && (
              <img
                src={receipt.dataUrl}
                alt="Fuel receipt"
                className="mt-2 max-h-48 w-full rounded-2xl object-contain"
              />
            )}
          </div>

          <textarea
            className="min-h-20 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 py-3 text-lg"
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />

          {formError && <p className="text-danger-500">{formError}</p>}
          <Button type="submit" disabled={isSubmitting || !canSubmit}>
            {isSubmitting ? 'Saving…' : 'Record fuel'}
          </Button>
        </form>
      )}
    </div>
  );
}
