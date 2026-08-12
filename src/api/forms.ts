import { apiClient } from './client';
import { getCache, setCache } from '@/lib/offline-db';
import { postOrQueue } from '@/lib/offline-post';
import type { FormAnswer, FormField, FormTemplate, Paginated } from './types';

const TEMPLATES_CACHE_KEY = 'form-templates-driver';
const DELIVERY_TEMPLATE_CACHE_KEY = 'form-template-delivery';

export interface ApplicableFormTemplates {
  items: FormTemplate[];
  fromCache: boolean;
  cachedAt?: number;
}

/**
 * Active form templates targeted at DriverOS (targetContext DRIVER or BOTH).
 * Same network-first-then-cache fallback as Smart Checklists' template fetch,
 * so a form already seen this shift can still be opened in a dead zone.
 */
export async function getApplicableFormTemplates(): Promise<ApplicableFormTemplates> {
  try {
    const { data } = await apiClient.get<Paginated<FormTemplate>>('/v1/form-templates', {
      params: { targetContext: 'DRIVER', pageSize: 50 },
    });
    await setCache(TEMPLATES_CACHE_KEY, data.items);
    return { items: data.items, fromCache: false };
  } catch (err) {
    const cached = await getCache<FormTemplate[]>(TEMPLATES_CACHE_KEY);
    if (cached) {
      return { items: cached.data, fromCache: true, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}

/**
 * The tenant's active delivery-confirmation (POD) evidence template, if any —
 * a form template with `targetContext: DELIVERY`. Returns `null` when the
 * company hasn't configured one (the legacy hardcoded photo/signature path then
 * applies). Network-first with the same offline cache fallback as the other
 * template fetches, so a driver who saw it this shift can still capture in a
 * dead zone. At most one active DELIVERY template exists per company, so the
 * first item is authoritative.
 */
export async function getActiveDeliveryFormTemplate(): Promise<FormTemplate | null> {
  try {
    const { data } = await apiClient.get<Paginated<FormTemplate>>('/v1/form-templates', {
      params: { targetContext: 'DELIVERY', pageSize: 1 },
    });
    const template = data.items[0] ?? null;
    await setCache(DELIVERY_TEMPLATE_CACHE_KEY, template);
    return template;
  } catch (err) {
    const cached = await getCache<FormTemplate | null>(DELIVERY_TEMPLATE_CACHE_KEY);
    if (cached) return cached.data;
    throw err;
  }
}

export interface SubmitFormInput {
  /** Client-generated so an outbox replay after a lost response is idempotent. */
  id: string;
  templateId: string;
  templateVersion: number;
  templateSnapshot: FormField[];
  answers: FormAnswer[];
}

export interface SubmitFormResult {
  queued: boolean;
}

/**
 * Submits a completed form to POST /v1/form-submissions. Offline (or on a
 * network failure `navigator.onLine` hasn't caught yet) the submission is
 * queued to the outbox rather than lost — exactly like a checklist or fault
 * report. The client-generated `id` makes a replayed queue entry a no-op
 * server-side, so a flaky reconnect never double-submits.
 */
export async function submitForm(input: SubmitFormInput): Promise<SubmitFormResult> {
  return postOrQueue('/v1/form-submissions', { body: input });
}

/**
 * Opens a form's reference document (a work instruction, the paper original).
 *
 * Deliberately NOT cached for offline use: it's arbitrary, potentially large
 * files, and the form is designed so nothing needed to *complete* it lives in
 * there. Offline this fails with a clear message rather than pretending.
 */
export async function openFormReferenceDocument(templateId: string): Promise<void> {
  const { data } = await apiClient.get<Blob>(`/v1/form-templates/${templateId}/reference`, { responseType: 'blob' });
  const url = URL.createObjectURL(data);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
