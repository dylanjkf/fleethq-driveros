import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * Offline-sync engine (04-DriverOS/DriverOS_Overview.md's "offline-first,
 * always" requirement). Three IndexedDB stores:
 *  - `outbox`: completed mutations, replayed in order on reconnect.
 *  - `cache`: last-known-good reads (Today's job, glovebox, checklist
 *    templates), shown with an "offline — last synced" indicator when a fresh
 *    fetch isn't possible.
 *  - `checklistDrafts`: in-progress checklist answers (added in the Smart
 *    Checklists milestone). This is the first operator-EDITABLE state — a
 *    checklist is filled in progressively, so every answer is persisted the
 *    moment it's made and reloaded on return, satisfying the spec's edge case
 *    ("loses/regains connectivity mid-flow: progress must persist locally and
 *    resume correctly, never losing captured answers"). A draft is local-only
 *    and single-writer (one operator, one device); only the *completed*
 *    checklist is sent, as a single immutable create — so the outbox stays
 *    create-only and there is still no multi-writer conflict to resolve.
 */

interface OutboxItem {
  id: string;
  method: 'POST';
  url: string;
  body: unknown;
  createdAt: number;
  /** Replay attempts so far — for backoff visibility and a "stuck?" signal. */
  attempts?: number;
  /** Human-readable reason the last replay attempt failed (for diagnostics). */
  lastError?: string;
  /**
   * Server error codes that mean "the desired state already holds", so a replay
   * that hits them is an idempotent SUCCESS, not a failure. Used by state-
   * transition mutations that have no create-id to dedup on: replaying a queued
   * shift start that returns SHIFT_ALREADY_ACTIVE (or an end that returns
   * SHIFT_NOT_ACTIVE) means the action already took effect on a prior attempt
   * whose response was lost — so it's cleared from the outbox instead of being
   * dead-lettered with a false red-banner failure.
   */
  idempotentReplayCodes?: string[];
}

/**
 * A mutation the server rejected with a *permanent* client error (a 4xx that
 * won't get better on retry — e.g. a stop already completed with a different
 * outcome, a shift already ended). Moved out of the outbox so one poison item
 * can never block the queue behind it (a driver's "broke down, need help"
 * message must still send). Surfaced in the UI so the driver can retry or
 * discard it rather than it silently blocking sync forever.
 */
export interface DeadLetterItem extends OutboxItem {
  /** The error that made this permanent. */
  lastError: string;
  /** When it was dead-lettered. */
  failedAt: number;
}

interface CacheRow {
  key: string;
  data: unknown;
  cachedAt: number;
}

/** In-progress checklist state, keyed by `${assetId}:${templateId}`. */
export interface ChecklistDraftRow {
  key: string;
  /** Stable, client-generated id used when this checklist is finally submitted,
   *  persisted so a retried/replayed submit reuses it and stays idempotent. */
  submissionId: string;
  assetId: string;
  assetName: string | null;
  templateId: string;
  templateVersion: number;
  templateName: string;
  items: unknown[];
  // status is absent on `text` items (they carry a written answer in `note`).
  answers: Record<string, { status?: 'pass' | 'fail' | 'na'; note?: string }>;
  startedAt: string;
  updatedAt: number;
}

interface DriverOSDB extends DBSchema {
  // `byCreatedAt` lets queueMutation find the current max ordering key with a
  // key-cursor, instead of loading every queued body (including base64 photos)
  // into memory just to compute it — see queueMutation.
  outbox: { key: string; value: OutboxItem; indexes: { byCreatedAt: number } };
  cache: { key: string; value: CacheRow };
  checklistDrafts: { key: string; value: ChecklistDraftRow };
  deadLetter: { key: string; value: DeadLetterItem };
}

let dbPromise: Promise<IDBPDatabase<DriverOSDB>> | null = null;

function getDb(): Promise<IDBPDatabase<DriverOSDB>> {
  if (!dbPromise) {
    dbPromise = openDB<DriverOSDB>('driveros', 4, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 1) {
          db.createObjectStore('outbox', { keyPath: 'id' });
          db.createObjectStore('cache', { keyPath: 'key' });
        }
        if (oldVersion < 2) {
          db.createObjectStore('checklistDrafts', { keyPath: 'key' });
        }
        if (oldVersion < 3) {
          db.createObjectStore('deadLetter', { keyPath: 'id' });
        }
        if (oldVersion < 4) {
          tx.objectStore('outbox').createIndex('byCreatedAt', 'createdAt');
        }
      },
      // An open blocked by another still-open connection at an older version
      // would otherwise leave this promise pending forever (a driver with the
      // PWA installed *and* a browser tab open is the classic trigger). Log it
      // so a genuinely stuck open is diagnosable rather than an invisible hang.
      blocked() {
        console.warn('[offline-db] IndexedDB open blocked by another connection; waiting for it to close');
      },
      // Our connection is what's blocking a newer version from upgrading in
      // another tab. Close it (and drop the cache so the next call re-opens)
      // so that tab isn't the one left hanging.
      blocking() {
        void dbPromise?.then((db) => db.close()).catch(() => undefined);
        dbPromise = null;
      },
      // The browser force-closed the connection (storage reclaimed, etc.).
      // Drop the cached handle so the next call re-opens rather than reusing a
      // dead one.
      terminated() {
        dbPromise = null;
      },
    }).catch((err) => {
      // A rejected open (private-mode, quota, a corrupt upgrade) must not poison
      // every later IndexedDB call for the whole session — clear the cache so
      // the next getDb() retries a fresh open instead of re-returning the
      // rejection.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

export function checklistDraftKey(assetId: string, templateId: string): string {
  return `${assetId}:${templateId}`;
}

export async function saveChecklistDraft(draft: ChecklistDraftRow): Promise<void> {
  const db = await getDb();
  await db.put('checklistDrafts', { ...draft, updatedAt: Date.now() });
}

export async function getChecklistDraft(key: string): Promise<ChecklistDraftRow | undefined> {
  const db = await getDb();
  return db.get('checklistDrafts', key);
}

export async function deleteChecklistDraft(key: string): Promise<void> {
  const db = await getDb();
  await db.delete('checklistDrafts', key);
}

/** Thrown when the device's IndexedDB budget is exhausted, so callers can tell
 *  the driver their capture was NOT saved (never silently drop it). */
export class OutboxQuotaError extends Error {
  constructor() {
    super('Device storage is full — free up space or reconnect to sync before capturing more.');
    this.name = 'OutboxQuotaError';
  }
}

function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && (err.name === 'QuotaExceededError' || err.code === 22);
}

export async function queueMutation(
  item: Pick<OutboxItem, 'method' | 'url' | 'body'> & Partial<Pick<OutboxItem, 'idempotentReplayCodes'>>,
): Promise<void> {
  const db = await getDb();
  // `createdAt` is the outbox's ordering key (see getOutbox), so it must be
  // strictly increasing per queued item — plain `Date.now()` isn't: several
  // mutations queued within the same millisecond would share a timestamp, and
  // since the store's own key is a random UUID, ties would then replay in
  // random order, silently violating the "replay in creation order" guarantee
  // the offline sync depends on. Reading the current max and stepping past it
  // keeps ordering monotonic even under a coarse clock, and stays correct
  // across app restarts because it's derived from persisted data, not an
  // in-memory counter.
  //
  // The max is read with a *key* cursor over the byCreatedAt index (descending,
  // first hit), which reads only the index keys — never the record bodies. That
  // matters on a cheap tablet mid-shift: a driver may have several queued PODs,
  // each carrying a multi-megabyte base64 photo, and deserialising all of them
  // just to stamp the next capture would spike memory on every save.
  const tx = db.transaction('outbox', 'readwrite');
  const newestKey = await tx.store.index('byCreatedAt').openKeyCursor(null, 'prev');
  const maxCreatedAt = newestKey ? Number(newestKey.key) : 0;
  const createdAt = Math.max(Date.now(), maxCreatedAt + 1);
  try {
    await tx.store.put({ ...item, id: crypto.randomUUID(), createdAt, attempts: 0 });
    await tx.done;
  } catch (err) {
    if (isQuotaError(err)) throw new OutboxQuotaError();
    throw err;
  }
}

export async function getOutbox(): Promise<OutboxItem[]> {
  const db = await getDb();
  const items = await db.getAll('outbox');
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

/** Pending count without deserialising every item body (avoids loading queued
 *  photo payloads into memory just to show a badge). */
export async function countOutbox(): Promise<number> {
  const db = await getDb();
  return db.count('outbox');
}

export async function removeFromOutbox(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('outbox', id);
}

/** Record a failed-but-retryable replay attempt on an item, keeping it queued. */
export async function markOutboxAttempt(id: string, attempts: number, lastError: string): Promise<void> {
  const db = await getDb();
  const item = await db.get('outbox', id);
  if (!item) return;
  await db.put('outbox', { ...item, attempts, lastError });
}

/** Move a permanently-rejected item out of the outbox so it can't block the
 *  queue behind it. Atomic (single transaction over both stores). */
export async function moveToDeadLetter(item: OutboxItem, lastError: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['outbox', 'deadLetter'], 'readwrite');
  await tx.objectStore('deadLetter').put({ ...item, lastError, failedAt: Date.now() });
  await tx.objectStore('outbox').delete(item.id);
  await tx.done;
}

export async function getDeadLetter(): Promise<DeadLetterItem[]> {
  const db = await getDb();
  const items = await db.getAll('deadLetter');
  return items.sort((a, b) => a.createdAt - b.createdAt);
}

export async function countDeadLetter(): Promise<number> {
  const db = await getDb();
  return db.count('deadLetter');
}

/** Put a dead-lettered item back on the queue (reset attempts) so a driver can
 *  retry once the underlying cause is resolved. Ordering is preserved via the
 *  item's original createdAt. */
export async function requeueDeadLetter(id: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['outbox', 'deadLetter'], 'readwrite');
  const item = await tx.objectStore('deadLetter').get(id);
  if (item) {
    const { failedAt: _failedAt, ...outboxItem } = item;
    await tx.objectStore('outbox').put({ ...outboxItem, attempts: 0, lastError: undefined });
    await tx.objectStore('deadLetter').delete(id);
  }
  await tx.done;
}

export async function discardDeadLetter(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('deadLetter', id);
}

export async function setCache(key: string, data: unknown): Promise<void> {
  const db = await getDb();
  await db.put('cache', { key, data, cachedAt: Date.now() });
}

export async function getCache<T>(key: string): Promise<{ data: T; cachedAt: number } | undefined> {
  const db = await getDb();
  const row = await db.get('cache', key);
  if (!row) return undefined;
  return { data: row.data as T, cachedAt: row.cachedAt };
}
