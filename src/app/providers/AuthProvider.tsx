import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as authApi from '@/api/auth';
import { setUnauthorizedHandler } from '@/api/client';
import { tokenStore } from '@/api/token-store';
import { getCache, setCache, clearSensitiveData } from '@/lib/offline-db';
import { clearPushBannerDismissal, disablePushNotifications } from '@/lib/push-registration';
import type { CurrentUser, LoginResult } from '@/api/types';

const ME_CACHE_KEY = 'me';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  isOffline: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  selectCompany: (preAuthToken: string, companyId: string) => Promise<LoginResult>;
  /** Set a new password after a login came back `password_expired`, finishing that login. */
  changeExpiredPassword: (changeToken: string, newPassword: string) => Promise<LoginResult>;
  logout: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const queryClient = useQueryClient();

  /**
   * Purge everything the departed driver leaves behind on a shared tablet — the
   * three layers the earlier IndexedDB-only wipe missed (Round 3 High/Low):
   *   - the in-memory React Query cache (what several screens paint from on first
   *     render), via queryClient.clear();
   *   - the IndexedDB caches, via clearSensitiveData() — now AWAITED so it's
   *     guaranteed to finish before the next login screen can render;
   *   - the OS push subscription, so notifications for the old driver stop.
   * Unsynced outbox work is deliberately preserved (see clearSensitiveData).
   */
  const purgeSessionData = useCallback(async () => {
    // Push teardown FIRST — the client's 401 handler now clears the access token
    // only after this runs, and the server-side unsubscribe needs a valid token
    // (same reasoning as logout below). Then wipe caches.
    await disablePushNotifications().catch(() => undefined);
    queryClient.clear();
    await clearSensitiveData().catch(() => undefined);
    // Per-driver UI preference on a shared tablet — clear it so the next driver
    // gets their own enable-push prompt rather than this driver's dismissal.
    clearPushBannerDismissal();
  }, [queryClient]);

  const loadCurrentUser = useCallback(async () => {
    try {
      const me = await authApi.getMe();
      await setCache(ME_CACHE_KEY, me);
      setUser(me);
      setStatus('authenticated');
    } catch {
      // Offline (or any other network failure) with a token already stored:
      // fall back to the last-known identity rather than logging the
      // operator out just because there's no signal right now — that would
      // directly violate "offline-first, always" (CLAUDE.md).
      const cached = await getCache<CurrentUser>(ME_CACHE_KEY);
      if (cached && tokenStore.get()) {
        setUser(cached.data);
        setStatus('authenticated');
      } else {
        tokenStore.clear();
        setUser(null);
        setStatus('unauthenticated');
      }
    }
  }, []);

  useEffect(() => {
    if (tokenStore.get()) {
      void loadCurrentUser();
    } else {
      setStatus('unauthenticated');
    }
  }, [loadCurrentUser]);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(async () => {
      // A confirmed dead session (see api/client.ts — a 401 re-validated against
      // /me) is a genuine end of session. Clear the in-memory query cache
      // synchronously so no screen can paint the old driver's data, then AWAIT the
      // IndexedDB + push purge (client.ts awaits this handler) so it is guaranteed
      // to complete rather than being fire-and-forgotten.
      queryClient.clear();
      await purgeSessionData();
      setUser(null);
      setStatus('unauthenticated');
    });
  }, [queryClient, purgeSessionData]);

  const login = useCallback(
    async (username: string, password: string) => {
      const result = await authApi.login(username, password);
      if (result.status === 'authenticated') {
        tokenStore.set(result.accessToken);
        await loadCurrentUser();
      }
      return result;
    },
    [loadCurrentUser],
  );

  const selectCompany = useCallback(
    async (preAuthToken: string, companyId: string) => {
      const result = await authApi.selectCompany(preAuthToken, companyId);
      if (result.status === 'authenticated') {
        tokenStore.set(result.accessToken);
        await loadCurrentUser();
      }
      return result;
    },
    [loadCurrentUser],
  );

  const changeExpiredPassword = useCallback(
    async (changeToken: string, newPassword: string) => {
      const result = await authApi.changeExpiredPassword(changeToken, newPassword);
      if (result.status === 'authenticated') {
        tokenStore.set(result.accessToken);
        await loadCurrentUser();
      }
      return result;
    },
    [loadCurrentUser],
  );

  const logout = useCallback(async () => {
    // Explicit logout on a shared tablet. Order matters:
    //  1. Tear down the push subscription FIRST, while the access token is still
    //     valid — the server-side unsubscribe (POST /v1/push/unsubscribe) needs
    //     auth, so clearing the token first (the previous order) left the
    //     subscription live server-side and the next driver's device could keep
    //     receiving this driver's notifications.
    //  2. THEN clear the token, so no further authenticated refetch can run.
    //  3. THEN wipe the local caches (in-memory query cache + IndexedDB), AWAITED
    //     so nothing survives before the login screen renders. Unsynced outbox
    //     work is deliberately kept (see clearSensitiveData).
    await disablePushNotifications().catch(() => undefined);
    tokenStore.clear();
    queryClient.clear();
    await clearSensitiveData().catch(() => undefined);
    // Clear the per-driver push-banner dismissal so the next driver on this
    // shared tablet is prompted for their own notifications.
    clearPushBannerDismissal();
    setUser(null);
    setStatus('unauthenticated');
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, isOffline, login, selectCompany, changeExpiredPassword, logout }),
    [status, user, isOffline, login, selectCompany, changeExpiredPassword, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
