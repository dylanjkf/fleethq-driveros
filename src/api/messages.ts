import { apiClient, ApiClientError } from './client';
import { getCache, setCache, queueMutation } from '@/lib/offline-db';
import { drainOutbox } from '@/lib/sync-engine';
import type { MessageThread } from './types';

const THREAD_CACHE_KEY = 'messages-thread';

export interface ThreadResult {
  thread: MessageThread;
  fromCache: boolean;
  cachedAt?: number;
}

/**
 * The operator's own message thread with the office. The server pins the thread
 * to the caller's linked Operator, so no operatorId is sent. Same
 * network-first-then-cache pattern as Today — a synced operator can still read
 * the last-known thread in a dead zone.
 */
export async function getThread(): Promise<ThreadResult> {
  try {
    const { data } = await apiClient.get<MessageThread>('/v1/messages');
    await setCache(THREAD_CACHE_KEY, data);
    return { thread: data, fromCache: false };
  } catch (err) {
    const cached = await getCache<MessageThread>(THREAD_CACHE_KEY);
    if (cached) {
      return { thread: cached.data, fromCache: true, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}

export interface SendMessageResult {
  queued: boolean;
}

/**
 * Sends a message to the office. Offline (or on a network failure) the message
 * is queued to the outbox and replayed on reconnect — never lost. No operatorId
 * is sent; the server posts it into the caller's own thread.
 */
export async function sendMessage(body: string): Promise<SendMessageResult> {
  // Stable idempotency key stamped once so an outbox replay after a lost
  // response can't double-post the same message to the office.
  const payload = { body, clientRequestId: crypto.randomUUID() };
  if (!navigator.onLine) {
    await queueMutation({ method: 'POST', url: '/v1/messages', body: payload });
    return { queued: true };
  }
  try {
    await apiClient.post('/v1/messages', payload);
    return { queued: false };
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 0) {
      await queueMutation({ method: 'POST', url: '/v1/messages', body: payload });
      void drainOutbox();
      return { queued: true };
    }
    throw err;
  }
}
