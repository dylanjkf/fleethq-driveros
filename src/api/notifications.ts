import { apiClient, ApiClientError } from './client';
import { getCache, setCache, queueMutation } from '@/lib/offline-db';
import { drainOutbox } from '@/lib/sync-engine';

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationList {
  items: AppNotification[];
  unreadCount: number;
  /** True when served from the offline cache — the UI distinguishes "you're all
   *  caught up" from "we couldn't reach the server". */
  fromCache: boolean;
}

const CACHE_KEY = 'notifications';

/**
 * Network-first, then last-synced. Offline the driver still sees the
 * notifications they'd already received rather than an empty screen that reads
 * like "nothing here" — and the `fromCache` flag lets the screen say so.
 */
export async function listNotifications(): Promise<NotificationList> {
  try {
    const { data } = await apiClient.get<Omit<NotificationList, 'fromCache'>>('/v1/notifications');
    await setCache(CACHE_KEY, data);
    return { ...data, fromCache: false };
  } catch (err) {
    const cached = await getCache<Omit<NotificationList, 'fromCache'>>(CACHE_KEY);
    if (cached) return { ...cached.data, fromCache: true };
    throw err;
  }
}

/**
 * Marking read is idempotent server-side, so offline it queues to the outbox
 * and replays on reconnect rather than the tap being silently lost. The cached
 * list is updated immediately so the dot clears now, not after sync.
 */
export async function markNotificationRead(id: string): Promise<void> {
  await applyReadToCache((n) => (n.id === id ? { ...n, readAt: n.readAt ?? new Date().toISOString() } : n));
  await postOrQueue(`/v1/notifications/${id}/read`);
}

export async function markAllNotificationsRead(): Promise<void> {
  const now = new Date().toISOString();
  await applyReadToCache((n) => ({ ...n, readAt: n.readAt ?? now }));
  await postOrQueue('/v1/notifications/read-all');
}

/** Update the cached notification list in place so read-state survives offline. */
async function applyReadToCache(update: (n: AppNotification) => AppNotification): Promise<void> {
  const cached = await getCache<Omit<NotificationList, 'fromCache'>>(CACHE_KEY);
  if (!cached) return;
  const items = cached.data.items.map(update);
  await setCache(CACHE_KEY, { items, unreadCount: items.filter((n) => !n.readAt).length });
}

async function postOrQueue(url: string): Promise<void> {
  if (!navigator.onLine) {
    await queueMutation({ method: 'POST', url, body: {} });
    return;
  }
  try {
    await apiClient.post(url);
  } catch (err) {
    if (err instanceof ApiClientError && err.status === 0) {
      await queueMutation({ method: 'POST', url, body: {} });
      void drainOutbox();
      return;
    }
    throw err;
  }
}
