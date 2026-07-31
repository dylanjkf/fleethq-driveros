import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { createFaultReport } from '@/api/maintenance';
import { Button } from '@/components/ui/Button';
import { StatusBar } from '@/components/ui/StatusBar';
import { useAuth } from '@/hooks/useAuth';
import { ApiClientError } from '@/api/client';

/**
 * Fault/Damage Reporting (04-DriverOS/DriverOS_Overview.md): "photo + note
 * capture, feeding Workshop directly." Photo capture isn't in this slice
 * (would need file-upload + storage, a separate decision) — title and
 * description, against the asset from the operator's current
 * job, matching this milestone's scope. An optional `title` query param can
 * pre-fill the fault title — opened, never submitted, so the operator still
 * confirms/edits it before anything is created.
 */
export function FaultReportPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const assetId = searchParams.get('assetId');
  const assetName = searchParams.get('assetName');

  const [title, setTitle] = useState(searchParams.get('title') ?? '');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!assetId || !user?.operator) return;
    setFormError(null);
    setIsSubmitting(true);
    try {
      const result = await createFaultReport({
        assetId,
        title,
        description: description || undefined,
        reportedByOperatorId: user.operator.id,
      });
      setConfirmation(
        result.queued
          ? "Saved on this device — it'll sync automatically once you're back online."
          : 'Report sent to Workshop.',
      );
      setTimeout(() => navigate('/'), 1500);
    } catch (err) {
      setFormError(err instanceof ApiClientError ? err.message : 'Could not submit. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!assetId) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-(--text-secondary)">
          Open this from your assigned job on Today so it's reported against the right asset.
        </p>
        <Button variant="secondary" onClick={() => navigate('/')}>
          Back to Today
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <StatusBar />
      <div className="px-6 py-5">
        <button className="mb-2 text-sm text-(--text-tertiary) underline" onClick={() => navigate('/')}>
          ← Back
        </button>
        <h1 className="text-2xl font-bold">Report a fault</h1>
        {assetName && <p className="text-(--text-secondary)">{assetName}</p>}
      </div>

      {confirmation ? (
        <p className="px-6 text-lg text-success-500">{confirmation}</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex-1 space-y-4 px-6">
          <input
            className="min-h-14 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 text-lg"
            placeholder="What's wrong? (e.g. Brake pads worn)"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            className="min-h-24 w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 py-3 text-lg"
            placeholder="Details (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {formError && <p className="text-danger-500">{formError}</p>}
          <Button type="submit" disabled={isSubmitting || !title.trim()}>
            {isSubmitting ? 'Submitting…' : 'Submit report'}
          </Button>
        </form>
      )}
    </div>
  );
}
