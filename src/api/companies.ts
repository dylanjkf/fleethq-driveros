import { apiClient } from './client';
import { getCache, setCache } from '@/lib/offline-db';

export interface SupportInfo {
  supportPhone: string | null;
  supportNotes: string | null;
}

const CACHE_KEY = 'support-info';

/**
 * 01-Product/Support_Help_Pathway.md — readable by any authenticated user.
 *
 * Cached network-first-then-last-synced. This one matters more than most: the
 * whole point of the support number is the driver who's stuck and offline, and
 * a `tel:` link works with zero connectivity — but only if we still know the
 * number. Without the cache the Help screen would tell a broken-down driver in a
 * dead zone that no support number exists, which is the exact moment they need
 * it. Fetched (and cached) whenever the app is online, so it's there when it
 * isn't.
 */
export async function getSupportInfo(): Promise<SupportInfo> {
  try {
    const { data } = await apiClient.get<SupportInfo>('/v1/companies/me/support');
    await setCache(CACHE_KEY, data);
    return data;
  } catch (err) {
    const cached = await getCache<SupportInfo>(CACHE_KEY);
    if (cached) return cached.data;
    throw err;
  }
}
