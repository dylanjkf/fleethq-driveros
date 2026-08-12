import { useMemo, useState } from 'react';
import { openFormReferenceDocument, submitForm } from '@/api/forms';
import { Button } from '@/components/ui/Button';
import { ApiClientError } from '@/api/client';
import { OutboxQuotaError } from '@/lib/offline-db';
import { FormFields, isEmptyValue, visibleFieldsFor } from './FormFields';
import type { FormTemplate } from '@/api/types';

interface FormRunnerProps {
  template: FormTemplate;
  /** From job context (same `?assetId=&assetName=` convention as Checklist/Glovebox/Fault report), if this form was opened from a job. */
  assetId: string | null;
  assetName: string | null;
  operatorId: string | null;
  operatorName: string | null;
  onDone: (message: string) => void;
}

/**
 * Runs one form template (01-Product/Universal_Forms.md), DriverOS side.
 * Answers live in local state only — unlike Smart Checklists there is no
 * IndexedDB draft-resume here (see the doc's Implementation notes for why
 * this slice skips it). The completed form is still submitted through the
 * generic offline outbox with a client-generated id, so a lost-connectivity
 * submit is queued and replayed exactly once rather than dropped.
 *
 * asset_ref/operator_ref fields don't get a search-and-select picker in this
 * slice — DriverOS has no general asset/operator directory to browse. They
 * resolve automatically: operator_ref to the operator filling the form in
 * (always available), asset_ref to the job asset this form was opened from
 * (only available when reached via a job's `?assetId=` link).
 */
export function FormRunner({ template, assetId, assetName, operatorId, operatorName, onDone }: FormRunnerProps) {
  const initialAnswers = useMemo(() => {
    const initial: Record<string, unknown> = {};
    for (const field of template.fields) {
      if (field.type === 'asset_ref' && assetId) initial[field.id] = assetId;
      if (field.type === 'operator_ref' && operatorId) initial[field.id] = operatorId;
    }
    return initial;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id]);

  const [answers, setAnswers] = useState<Record<string, unknown>>(initialAnswers);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  const visibleFields = visibleFieldsFor(template.fields, answers);

  function setValue(fieldId: string, value: unknown) {
    setAnswers((prev) => ({ ...prev, [fieldId]: value }));
    setError(null);
  }

  async function handleSubmit() {
    setError(null);
    for (const field of visibleFields) {
      if (field.required && isEmptyValue(answers[field.id])) {
        if (field.type === 'asset_ref' && !assetId) {
          setError(`"${field.label}" needs a vehicle — open this form from your current job.`);
          return;
        }
        setError(`Answer "${field.label}" before submitting.`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const result = await submitForm({
        id: crypto.randomUUID(),
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: template.fields,
        answers: visibleFields
          .filter((f) => !isEmptyValue(answers[f.id]))
          .map((f) => ({ fieldId: f.id, value: answers[f.id] })),
      });
      onDone(
        result.queued
          ? "Saved on this device — it'll sync automatically once you're back online."
          : 'Form submitted.',
      );
    } catch (err) {
      // A quota failure means the form was NOT saved — surface it plainly and
      // keep the driver on the page so their answers aren't silently lost.
      if (err instanceof OutboxQuotaError) setError(err.message);
      else setError(err instanceof ApiClientError ? err.message : 'Could not submit. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function openReference() {
    setReferenceError(null);
    try {
      await openFormReferenceDocument(template.id);
    } catch {
      // Honest, specific message: the form is still completable without it.
      setReferenceError("Couldn't open it — you may be offline. You can still fill in the form.");
    }
  }

  return (
    <div className="flex-1 space-y-4 px-6 pb-8">
      {template.description && <p className="text-(--text-secondary)">{template.description}</p>}

      {template.referenceDocument && (
        <button
          type="button"
          className="w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-4 py-3 text-left"
          onClick={() => void openReference()}
        >
          <span className="block font-semibold">📄 {template.referenceDocument.title}</span>
          <span className="block text-sm text-(--text-tertiary)">
            {referenceError ?? 'Reference document — tap to open (needs a connection)'}
          </span>
        </button>
      )}

      <FormFields
        fields={visibleFields}
        answers={answers}
        onChange={setValue}
        assetId={assetId}
        assetName={assetName}
        operatorName={operatorName}
      />

      {error && <p className="text-danger-500">{error}</p>}
      <Button onClick={handleSubmit} disabled={isSubmitting}>
        {isSubmitting ? 'Submitting…' : 'Submit form'}
      </Button>
    </div>
  );
}
