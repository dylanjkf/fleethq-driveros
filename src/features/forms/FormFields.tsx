import { useState, type ChangeEvent } from 'react';
import { SignaturePad } from '@/components/ui/SignaturePad';
import { compressImageFile, MAX_PHOTO_BYTES } from '@/lib/image';
import type { AttachmentAnswerValue, FormField } from '@/api/types';

/** A single-level show/hide: a field is visible unless its controller field's
 *  current answer doesn't match. Shared by the runner and the POD capture. */
export function isVisible(showIfFieldId: string | null, showIfValue: string | null, answers: Record<string, unknown>): boolean {
  if (!showIfFieldId) return true;
  const controllerValue = answers[showIfFieldId];
  if (controllerValue === undefined) return false;
  if (Array.isArray(controllerValue)) return controllerValue.includes(showIfValue);
  return String(controllerValue) === showIfValue;
}

export function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** The fields of `fields` that are currently visible given `answers`. */
export function visibleFieldsFor(fields: FormField[], answers: Record<string, unknown>): FormField[] {
  return fields.filter((f) => isVisible(f.showIfFieldId, f.showIfValue, answers));
}

/** Strip a `data:<type>;base64,<payload>` URL down to its bare base64 payload —
 *  the shape the backend expects for a photo/signature answer value. */
function toBase64Payload(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** Reconstruct a previewable data URL from a stored attachment answer. */
function previewUrl(value: AttachmentAnswerValue): string {
  return `data:${value.contentType};base64,${value.base64}`;
}

interface FormFieldsProps {
  /** Already visibility-filtered (see `visibleFieldsFor`). */
  fields: FormField[];
  answers: Record<string, unknown>;
  /** Set/clear one field's answer. `undefined` clears it. */
  onChange: (fieldId: string, value: unknown) => void;
  assetId?: string | null;
  assetName?: string | null;
  operatorName?: string | null;
}

/**
 * Renders the input controls for a set of form fields — the shared field
 * rendering behind both the standalone FormRunner and the drop-confirmation POD
 * capture in StopPage. `photo` and `signature` capture an attachment and answer
 * as `{ contentType, filename, base64 }`; the rest carry a plain scalar/array.
 */
export function FormFields({ fields, answers, onChange, assetName, operatorName }: FormFieldsProps) {
  const [photoErrors, setPhotoErrors] = useState<Record<string, string>>({});

  function toggleMulti(fieldId: string, option: string) {
    const current = Array.isArray(answers[fieldId]) ? (answers[fieldId] as string[]) : [];
    const next = current.includes(option) ? current.filter((o) => o !== option) : [...current, option];
    onChange(fieldId, next);
  }

  async function onPickPhoto(fieldId: string, e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoErrors((prev) => ({ ...prev, [fieldId]: '' }));
    try {
      // Downscale before it hits state or the outbox — legible but small enough
      // to never trip the server's attachment cap (a poison on offline replay).
      const compressed = await compressImageFile(file);
      if (compressed.bytes > MAX_PHOTO_BYTES) {
        setPhotoErrors((prev) => ({ ...prev, [fieldId]: 'That photo is too large even after compression. Try a lower-resolution shot.' }));
        return;
      }
      const value: AttachmentAnswerValue = {
        contentType: compressed.contentType,
        filename: compressed.filename,
        base64: toBase64Payload(compressed.dataUrl),
      };
      onChange(fieldId, value);
    } catch {
      setPhotoErrors((prev) => ({ ...prev, [fieldId]: 'Could not process that photo. Try again.' }));
    }
  }

  return (
    <>
      {fields.map((field) => {
        const attachment = answers[field.id] as AttachmentAnswerValue | undefined;
        return (
          <div key={field.id} className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4">
            <p className="text-lg font-semibold">
              {field.label}
              {field.required && <span className="text-danger-500"> *</span>}
            </p>

            {field.type === 'text' && (
              <input
                type="text"
                className="mt-3 min-h-14 w-full rounded-xl border border-(--border-subtle) bg-(--surface-0) px-4 text-base"
                value={(answers[field.id] as string) ?? ''}
                onChange={(e) => onChange(field.id, e.target.value)}
              />
            )}

            {field.type === 'number' && (
              <input
                type="number"
                className="mt-3 min-h-14 w-full rounded-xl border border-(--border-subtle) bg-(--surface-0) px-4 text-base"
                value={(answers[field.id] as number | undefined) ?? ''}
                onChange={(e) => onChange(field.id, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            )}

            {field.type === 'date' && (
              <input
                type="date"
                className="mt-3 min-h-14 w-full rounded-xl border border-(--border-subtle) bg-(--surface-0) px-4 text-base"
                value={(answers[field.id] as string) ?? ''}
                onChange={(e) => onChange(field.id, e.target.value)}
              />
            )}

            {field.type === 'single_select' && (
              <div className="mt-3 flex flex-wrap gap-2">
                {(field.options ?? []).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => onChange(field.id, option)}
                    className={`min-h-12 rounded-xl px-4 text-base font-medium transition-colors ${
                      answers[field.id] === option ? 'bg-accent-600 text-white' : 'bg-(--surface-2) text-(--text-secondary)'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            )}

            {field.type === 'multi_select' && (
              <div className="mt-3 flex flex-wrap gap-2">
                {(field.options ?? []).map((option) => {
                  const selected = Array.isArray(answers[field.id]) && (answers[field.id] as string[]).includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => toggleMulti(field.id, option)}
                      className={`min-h-12 rounded-xl px-4 text-base font-medium transition-colors ${
                        selected ? 'bg-accent-600 text-white' : 'bg-(--surface-2) text-(--text-secondary)'
                      }`}
                    >
                      {option}
                    </button>
                  );
                })}
              </div>
            )}

            {field.type === 'asset_ref' && (
              <p className="mt-3 text-base text-(--text-secondary)">
                {assetName ? `Vehicle: ${assetName}` : 'Open this form from your current job to fill this in.'}
              </p>
            )}

            {field.type === 'operator_ref' && (
              <p className="mt-3 text-base text-(--text-secondary)">
                {operatorName ? `You — ${operatorName}` : 'Not available.'}
              </p>
            )}

            {field.type === 'photo' && (
              <label className="mt-3 block">
                {attachment ? (
                  <div className="relative">
                    <img src={previewUrl(attachment)} alt={field.label} className="w-full rounded-2xl border border-(--border-subtle)" />
                    <button
                      type="button"
                      onClick={() => onChange(field.id, undefined)}
                      className="absolute right-2 top-2 rounded-full bg-(--surface-0)/80 px-3 py-1 text-sm"
                    >
                      Retake
                    </button>
                  </div>
                ) : (
                  <span className="flex min-h-14 items-center justify-center rounded-2xl border border-dashed border-(--border-subtle) bg-(--surface-0) text-(--text-secondary)">
                    Tap to take a photo
                  </span>
                )}
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onPickPhoto(field.id, e)} />
                {photoErrors[field.id] && <span className="mt-2 block text-sm text-danger-500">{photoErrors[field.id]}</span>}
              </label>
            )}

            {field.type === 'signature' && (
              <div className="mt-3">
                <SignaturePad
                  onChange={(dataUrl) =>
                    onChange(
                      field.id,
                      dataUrl ? { contentType: 'image/png', filename: 'signature.png', base64: toBase64Payload(dataUrl) } : undefined,
                    )
                  }
                />
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
