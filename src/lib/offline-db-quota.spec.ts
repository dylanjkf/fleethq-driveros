import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OfflineDb from './offline-db';

// saveChecklistDraft must fail LOUDLY when the device's IndexedDB budget is
// exhausted — the same guarantee queueMutation already gives — so a driver on a
// full device is told their answer wasn't stored instead of silently losing the
// safety checklist. A real quota exhaustion can't be provoked headlessly, so we
// stub `idb`'s db.put to reject with the DOMException the browser raises, and
// assert the typed OutboxQuotaError comes back out.
const putMock = vi.fn();

vi.mock('idb', () => ({
  // offline-db passes an options object (upgrade/blocked/…); the fake ignores it.
  openDB: vi.fn(async () => ({
    put: (...args: unknown[]) => putMock(...args),
  })),
}));

let offlineDb: typeof OfflineDb;

function makeDraft(): OfflineDb.ChecklistDraftRow {
  return {
    key: 'asset-1:template-1',
    submissionId: 'sub-1',
    assetId: 'asset-1',
    assetName: 'Test Truck',
    templateId: 'template-1',
    templateVersion: 1,
    templateName: 'Pre-start',
    items: [],
    answers: { tyres: { status: 'pass' } },
    startedAt: new Date().toISOString(),
    updatedAt: 0,
  };
}

beforeEach(async () => {
  vi.resetModules();
  putMock.mockReset();
  offlineDb = await import('./offline-db');
});

describe('saveChecklistDraft quota handling', () => {
  it('throws a typed OutboxQuotaError when the device storage budget is exhausted', async () => {
    putMock.mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    await expect(offlineDb.saveChecklistDraft(makeDraft())).rejects.toBeInstanceOf(offlineDb.OutboxQuotaError);
  });

  it('rethrows a non-quota write failure unchanged (not masked as a quota error)', async () => {
    const boom = new Error('some other write failure');
    putMock.mockRejectedValue(boom);
    await expect(offlineDb.saveChecklistDraft(makeDraft())).rejects.toBe(boom);
  });

  it('resolves normally when the write succeeds', async () => {
    putMock.mockResolvedValue(undefined);
    await expect(offlineDb.saveChecklistDraft(makeDraft())).resolves.toBeUndefined();
    expect(putMock).toHaveBeenCalledWith('checklistDrafts', expect.objectContaining({ key: 'asset-1:template-1' }));
  });
});
