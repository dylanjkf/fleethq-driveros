import { apiClient } from './client';
import type { OperatorFatigueStatus } from './types';

/**
 * The operator's own current fatigue status (08-Compliance/
 * Australian_Compliance.md). No offline cache fallback, unlike Today's job
 * list or Checklist templates — a stale fatigue reading (computed against
 * "now") would be actively misleading rather than merely outdated, so this
 * card simply doesn't render when the network is down instead of showing a
 * number that's no longer true.
 */
export async function getMyFatigueStatus(): Promise<OperatorFatigueStatus> {
  const { data } = await apiClient.get<OperatorFatigueStatus>('/v1/fatigue/me');
  return data;
}
