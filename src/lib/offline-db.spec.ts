import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type * as OfflineDb from './offline-db';

// offline-db.ts caches its DB connection in a module-level singleton
// (`dbPromise`), which is correct for the running app (one IndexedDB
// connection for the app's lifetime) but means tests must reset BOTH the
// fake IndexedDB backend AND vitest's module registry between tests —
// otherwise every test after the first reuses the first test's already-open
// connection and its data, regardless of a fresh IDBFactory being installed.
let offlineDb: typeof OfflineDb;

beforeEach(async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).indexedDB = new IDBFactory();
  vi.resetModules();
  offlineDb = await import('./offline-db');
});

describe('offline-db outbox', () => {
  it('starts empty', async () => {
    expect(await offlineDb.getOutbox()).toEqual([]);
  });

  it('returns queued mutations in creation order', async () => {
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/maintenance-jobs', body: { title: 'first' } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/maintenance-jobs', body: { title: 'second' } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/maintenance-jobs', body: { title: 'third' } });

    const items = await offlineDb.getOutbox();
    expect(items.map((i) => (i.body as { title: string }).title)).toEqual(['first', 'second', 'third']);
  });

  it('removes exactly the requested item, leaving the rest queued', async () => {
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/x', body: { n: 1 } });
    await offlineDb.queueMutation({ method: 'POST', url: '/v1/x', body: { n: 2 } });
    const [first, second] = await offlineDb.getOutbox();

    await offlineDb.removeFromOutbox(first.id);

    const remaining = await offlineDb.getOutbox();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(second.id);
  });
});

describe('offline-db cache', () => {
  it('round-trips a cached read with its timestamp', async () => {
    await offlineDb.setCache('today-job', { id: 'job-1' });
    const cached = await offlineDb.getCache<{ id: string }>('today-job');
    expect(cached?.data).toEqual({ id: 'job-1' });
    expect(typeof cached?.cachedAt).toBe('number');
  });

  it('returns undefined for a key that was never cached', async () => {
    expect(await offlineDb.getCache('never-set')).toBeUndefined();
  });
});

describe('offline-db checklist drafts', () => {
  function makeDraft(): OfflineDb.ChecklistDraftRow {
    return {
      key: offlineDb.checklistDraftKey('asset-1', 'template-1'),
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

  it('persists progressive answers and reloads them (loses/regains connectivity mid-flow must not lose captured answers)', async () => {
    const draft = makeDraft();
    await offlineDb.saveChecklistDraft(draft);
    const loaded = await offlineDb.getChecklistDraft(draft.key);
    expect(loaded?.answers).toEqual({ tyres: { status: 'pass' } });
    expect(loaded?.submissionId).toBe('sub-1'); // stable id reused on retry so a replayed submit stays idempotent

    // Simulate the operator answering another item before the checklist is submitted.
    await offlineDb.saveChecklistDraft({ ...draft, answers: { ...draft.answers, brakes: { status: 'fail', note: 'squeaking' } } });
    const updated = await offlineDb.getChecklistDraft(draft.key);
    expect(updated?.answers).toEqual({ tyres: { status: 'pass' }, brakes: { status: 'fail', note: 'squeaking' } });
  });

  it('deletes a draft once its checklist is submitted', async () => {
    const draft = makeDraft();
    await offlineDb.saveChecklistDraft(draft);
    await offlineDb.deleteChecklistDraft(draft.key);
    expect(await offlineDb.getChecklistDraft(draft.key)).toBeUndefined();
  });
});
