import { useEffect, useMemo, useState } from 'react';
import { submitChecklist } from '@/api/checklists';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { ApiClientError } from '@/api/client';
import {
  checklistDraftKey,
  deleteChecklistDraft,
  getChecklistDraft,
  saveChecklistDraft,
} from '@/lib/offline-db';
import type { ChecklistAnswerStatus, ChecklistTemplate } from '@/api/types';

interface AnswerState {
  // Absent on a `text` item — those carry only a written answer in `note`.
  status?: ChecklistAnswerStatus;
  note?: string;
}

interface ChecklistRunnerProps {
  template: ChecklistTemplate;
  assetId: string;
  assetName: string | null;
  onDone: (message: string) => void;
}

const STATUS_BUTTONS: { status: ChecklistAnswerStatus; label: string; on: string }[] = [
  { status: 'pass', label: 'Pass', on: 'bg-success-500 text-white' },
  { status: 'fail', label: 'Fail', on: 'bg-danger-500 text-white' },
  { status: 'na', label: 'N/A', on: 'bg-(--surface-2) text-(--text-primary)' },
];

/**
 * Runs one checklist template offline-first. Every answer is written to the
 * `checklistDrafts` IndexedDB store the instant it changes, and the draft is
 * reloaded on mount — so losing (or regaining) connectivity mid-flow never
 * loses captured answers. The completed checklist is submitted as a single
 * immutable create carrying a stable client id (idempotent on replay).
 */
export function ChecklistRunner({ template, assetId, assetName, onDone }: ChecklistRunnerProps) {
  const draftKey = checklistDraftKey(assetId, template.id);
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [submissionId, setSubmissionId] = useState<string>('');
  const [startedAt, setStartedAt] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Resume an existing draft, or start a fresh one pinned to this template
  // version and a stable submission id.
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const existing = await getChecklistDraft(draftKey);
        if (!active) return;
        if (existing && existing.templateVersion === template.version) {
          setAnswers(existing.answers as Record<string, AnswerState>);
          setSubmissionId(existing.submissionId);
          setStartedAt(existing.startedAt);
        } else {
          // No draft, or the office published a new template version since the
          // last draft — start clean against the version actually shown now.
          setAnswers({});
          setSubmissionId(crypto.randomUUID());
          setStartedAt(new Date().toISOString());
        }
      } catch {
        // The draft store was unreadable (private mode, a blocked IndexedDB
        // upgrade, storage reclaimed). Draft persistence is best-effort, so
        // never strand the operator on "Loading…" — start a fresh in-memory
        // run. Submit still works; it falls back to the outbox on send.
        if (!active) return;
        setAnswers({});
        setSubmissionId(crypto.randomUUID());
        setStartedAt(new Date().toISOString());
      } finally {
        // Whatever happened above, reveal the checklist — the gate must never
        // stay closed, which was the "stuck on Loading…" bug.
        if (active) setLoaded(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [draftKey, template.version]);

  const answeredCount = useMemo(
    () =>
      template.items.filter((item) =>
        item.type === 'text' ? !!answers[item.id]?.note?.trim() : !!answers[item.id]?.status,
      ).length,
    [answers, template.items],
  );

  async function persist(next: Record<string, AnswerState>) {
    await saveChecklistDraft({
      key: draftKey,
      submissionId,
      assetId,
      assetName,
      templateId: template.id,
      templateVersion: template.version,
      templateName: template.name,
      items: template.items,
      answers: next,
      startedAt,
      updatedAt: Date.now(),
    });
  }

  function setStatus(itemId: string, status: ChecklistAnswerStatus) {
    setAnswers((prev) => {
      const next = { ...prev, [itemId]: { ...prev[itemId], status } };
      void persist(next);
      return next;
    });
    setError(null);
  }

  function setNote(itemId: string, note: string) {
    setAnswers((prev) => {
      // Preserve whatever status is already set (undefined for `text` items).
      const next = { ...prev, [itemId]: { ...prev[itemId], note } };
      void persist(next);
      return next;
    });
    setError(null);
  }

  async function handleSubmit() {
    setError(null);
    // Validate the same rules the server enforces, so the operator gets
    // instant feedback instead of a round-trip rejection.
    for (const item of template.items) {
      const answer = answers[item.id];
      if (item.type === 'text') {
        if (!answer?.note?.trim()) {
          setError(`Write an answer for "${item.label}".`);
          return;
        }
        continue;
      }
      if (!answer?.status) {
        setError('Answer every item before submitting.');
        return;
      }
      if (answer.status === 'fail' && item.requireNoteOnFail && !answer.note?.trim()) {
        setError(`Add a note explaining the fail on "${item.label}".`);
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const result = await submitChecklist({
        id: submissionId,
        templateId: template.id,
        templateVersion: template.version,
        templateSnapshot: template.items,
        assetId,
        answers: template.items.map((item) => ({
          itemId: item.id,
          // `text` items send only the written answer (no pass/fail status).
          status: item.type === 'text' ? undefined : answers[item.id].status,
          note: answers[item.id]?.note?.trim() || undefined,
        })),
        startedAt,
      });
      await deleteChecklistDraft(draftKey);
      onDone(
        result.queued
          ? "Saved on this device — it'll sync automatically once you're back online."
          : 'Inspection submitted.',
      );
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not submit. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!loaded) {
    return (
      <div className="flex-1 space-y-4 px-6 pb-8">
        <Skeleton className="h-4 w-40" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3 rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
            <Skeleton className="h-6 w-3/4" />
            <div className="flex gap-2">
              <Skeleton className="h-14 flex-1" />
              <Skeleton className="h-14 flex-1" />
              <Skeleton className="h-14 flex-1" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex-1 space-y-4 px-6 pb-8">
      <p className="text-sm text-(--text-tertiary)">
        {answeredCount} of {template.items.length} answered · v{template.version}
      </p>

      {template.items.map((item) => {
        const answer = answers[item.id];

        // A written-answer item: no pass/fail, just a text box that's always shown.
        if (item.type === 'text') {
          return (
            <div key={item.id} className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
              <p className="text-lg font-semibold">{item.label}</p>
              <textarea
                className="mt-3 min-h-20 w-full rounded-xl border border-(--border-subtle) bg-(--surface-0) px-4 py-3 text-base"
                placeholder="Write your answer…"
                value={answer?.note ?? ''}
                onChange={(e) => setNote(item.id, e.target.value)}
              />
            </div>
          );
        }

        const showNote = answer?.status === 'fail';
        return (
          <div key={item.id} className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
            <p className="text-lg font-semibold">{item.label}</p>
            <div className="mt-3 flex gap-2">
              {STATUS_BUTTONS.filter((b) => b.status !== 'na' || item.type === 'pass_fail_na').map((b) => (
                <button
                  key={b.status}
                  type="button"
                  onClick={() => setStatus(item.id, b.status)}
                  className={`min-h-14 flex-1 rounded-xl text-lg font-semibold transition-colors ${
                    answer?.status === b.status ? b.on : 'bg-(--surface-2) text-(--text-secondary)'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
            {showNote && (
              <textarea
                className="mt-3 min-h-20 w-full rounded-xl border border-(--border-subtle) bg-(--surface-0) px-4 py-3 text-base"
                placeholder={
                  item.requireNoteOnFail ? 'Note required — what did you find?' : 'Add a note (optional)'
                }
                value={answer?.note ?? ''}
                onChange={(e) => setNote(item.id, e.target.value)}
              />
            )}
            {item.createsFaultOnFail && answer?.status === 'fail' && (
              <p className="mt-2 text-sm text-warning-500">A workshop job will be raised for this on submit.</p>
            )}
          </div>
        );
      })}

      {error && <p className="text-danger-500">{error}</p>}
      <Button onClick={handleSubmit} disabled={isSubmitting}>
        {isSubmitting ? 'Submitting…' : 'Submit inspection'}
      </Button>
    </div>
  );
}
