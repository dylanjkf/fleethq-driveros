import { postOrQueue } from '@/lib/offline-post';

export interface CreateFaultReportInput {
  assetId: string;
  title: string;
  description?: string;
  reportedByOperatorId: string;
}

export interface CreateFaultReportResult {
  queued: boolean;
}

/**
 * Fault/Damage Reporting (04-DriverOS/DriverOS_Overview.md), feeding
 * Workshop directly via the existing POST /v1/maintenance-jobs — no new
 * backend endpoint needed. Offline, the report is queued to the outbox
 * instead of lost; a network failure while "online" (e.g. a dead cell zone
 * `navigator.onLine` hasn't caught yet) is treated the same way.
 */
export async function createFaultReport(input: CreateFaultReportInput): Promise<CreateFaultReportResult> {
  const url = '/v1/maintenance-jobs';
  // Stable idempotency key stamped once so an outbox replay after a lost
  // response can't open a duplicate workshop job.
  const body = { ...input, clientRequestId: crypto.randomUUID() };
  return postOrQueue(url, { body });
}
