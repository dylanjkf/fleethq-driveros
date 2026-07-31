import { useEffect, useState } from 'react';
import { subscribeOutbox, type OutboxState } from '@/lib/sync-engine';

/** Live outbox state — queued-but-not-yet-synced mutations, plus any that
 *  permanently failed and need the driver's attention. */
export function useOutbox(): OutboxState {
  const [state, setState] = useState<OutboxState>({ pending: 0, failed: 0 });
  useEffect(() => subscribeOutbox(setState), []);
  return state;
}
