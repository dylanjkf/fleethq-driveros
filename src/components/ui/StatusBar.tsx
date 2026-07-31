import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useOutbox } from '@/hooks/useOutbox';
import { discardDeadLettered, retryDeadLettered } from '@/lib/sync-engine';
import { getDeadLetter, type DeadLetterItem } from '@/lib/offline-db';

/** A queued mutation's URL made human — "Delivery", "Fuel entry", etc. — so the
 *  driver can tell what actually failed rather than reading an API path. */
function describeItem(item: DeadLetterItem): string {
  const url = item.url;
  if (url.includes('/complete')) return 'Delivery record';
  if (url.includes('/parcels/scan')) return 'Parcel scan';
  if (url.includes('/shifts/start')) return 'Shift start';
  if (url.includes('/shifts/end')) return 'Shift end';
  if (url.includes('/fuel')) return 'Fuel entry';
  if (url.includes('/maintenance')) return 'Fault report';
  if (url.includes('/checklist')) return 'Inspection';
  if (url.includes('/form')) return 'Form submission';
  if (url.includes('/messages')) return 'Message';
  return 'Saved action';
}

/** Always-visible connectivity + pending-sync state — never hidden, per "offline behavior must be transparent." */
export function StatusBar() {
  const { isOffline } = useAuth();
  const { pending, failed } = useOutbox();
  const [retrying, setRetrying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<DeadLetterItem[]>([]);

  if (!isOffline && pending === 0 && failed === 0) return null;

  async function handleRetry() {
    setRetrying(true);
    try {
      await retryDeadLettered();
    } finally {
      setRetrying(false);
    }
  }

  async function toggleDetails() {
    const next = !expanded;
    setExpanded(next);
    if (next) setItems(await getDeadLetter());
  }

  async function handleDiscard(id?: string) {
    await discardDeadLettered(id);
    // Keep the open list in sync with what's left.
    setItems(await getDeadLetter());
  }

  return (
    <div className="sticky top-0 z-40 flex flex-col gap-1">
      {(isOffline || pending > 0) && (
        <div className="flex items-center justify-center gap-2 border-b border-black/10 bg-warning-500 px-4 py-2 text-center text-sm font-semibold text-black backdrop-blur-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-black/40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-black/70" />
          </span>
          {isOffline && <span>Offline — showing last synced data</span>}
          {isOffline && pending > 0 && <span aria-hidden>·</span>}
          {pending > 0 && (
            <span>
              {pending} report{pending === 1 ? '' : 's'} waiting to sync
            </span>
          )}
        </div>
      )}
      {failed > 0 && (
        <div className="border-b border-black/10 bg-danger-500 text-white">
          <div className="flex items-center justify-center gap-3 px-4 py-2 text-center text-sm font-semibold">
            <span>
              {failed} item{failed === 1 ? '' : 's'} couldn&apos;t sync
            </span>
            <button
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying}
              className="rounded-md bg-white/20 px-3 py-1 text-xs font-bold uppercase tracking-wide disabled:opacity-60"
            >
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
            <button
              type="button"
              onClick={() => void toggleDetails()}
              className="rounded-md bg-white/10 px-3 py-1 text-xs font-bold uppercase tracking-wide"
            >
              {expanded ? 'Hide' : 'Review'}
            </button>
          </div>
          {expanded && (
            <div className="space-y-2 px-4 pb-3 text-left">
              {items.map((item) => (
                <div key={item.id} className="flex items-center gap-3 rounded-lg bg-black/15 px-3 py-2">
                  <span className="flex-1 text-sm">
                    <span className="block font-semibold">{describeItem(item)}</span>
                    <span className="block text-xs text-white/70">{item.lastError}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleDiscard(item.id)}
                    className="rounded-md bg-white/20 px-3 py-1 text-xs font-bold uppercase tracking-wide"
                  >
                    Discard
                  </button>
                </div>
              ))}
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={() => void handleDiscard()}
                  className="w-full rounded-md bg-white/10 px-3 py-2 text-xs font-bold uppercase tracking-wide"
                >
                  Discard all
                </button>
              )}
              <p className="text-xs text-white/70">
                Retry once the problem&apos;s fixed, or discard if this was already handled another way.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
