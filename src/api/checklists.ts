import { apiClient } from './client';
import { getCache, setCache } from '@/lib/offline-db';
import { postOrQueue } from '@/lib/offline-post';
import type { ChecklistAnswer, ChecklistItem, ChecklistTemplate, Paginated } from './types';

function templatesCacheKey(assetId: string): string {
  return `checklist-templates-${assetId}`;
}

export interface ApplicableTemplates {
  items: ChecklistTemplate[];
  fromCache: boolean;
  cachedAt?: number;
}

/**
 * The checklist template(s) that apply to the operator's current asset. Same
 * network-first-then-cache pattern as Today and Digital Glovebox, so an
 * operator who synced earlier can still open and complete their pre-start
 * checklist in a dead zone.
 */
export async function getApplicableTemplates(assetId: string): Promise<ApplicableTemplates> {
  try {
    const { data } = await apiClient.get<Paginated<ChecklistTemplate>>('/v1/checklist-templates', {
      params: { assetId, pageSize: 50 },
    });
    await setCache(templatesCacheKey(assetId), data.items);
    return { items: data.items, fromCache: false };
  } catch (err) {
    const cached = await getCache<ChecklistTemplate[]>(templatesCacheKey(assetId));
    if (cached) {
      return { items: cached.data, fromCache: true, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}

export interface SubmitChecklistInput {
  /** Client-generated so an outbox replay after a lost response is idempotent. */
  id: string;
  templateId: string;
  templateVersion: number;
  templateSnapshot: ChecklistItem[];
  assetId: string;
  answers: ChecklistAnswer[];
  startedAt: string;
}

export interface SubmitChecklistResult {
  queued: boolean;
}

/**
 * Submits a completed checklist to POST /v1/checklist-submissions. Offline (or
 * on a network failure `navigator.onLine` hasn't caught yet) the completed
 * checklist is queued to the outbox rather than lost — exactly like a fault
 * report. Because the submission carries a client-generated `id`, a replayed
 * queue entry is deduplicated server-side, so a flaky reconnect can never
 * create the same checklist (or its auto-created workshop job) twice.
 */
export async function submitChecklist(input: SubmitChecklistInput): Promise<SubmitChecklistResult> {
  return postOrQueue('/v1/checklist-submissions', { body: input });
}
