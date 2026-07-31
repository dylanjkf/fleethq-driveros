import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as authApi from '@/api/auth';
import { setUnauthorizedHandler } from '@/api/client';
import { tokenStore } from '@/api/token-store';
import { getCache, setCache } from '@/lib/offline-db';
import type { CurrentUser, LoginResult } from '@/api/types';

const ME_CACHE_KEY = 'me';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  isOffline: boolean;
  login: (username: string, password: string) => Promise<LoginResult>;
  selectCompany: (preAuthToken: string, companyId: string) => Promise<LoginResult>;
  logout: () => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

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
    setUnauthorizedHandler(() => {
      setUser(null);
      setStatus('unauthenticated');
    });
  }, []);

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

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, isOffline, login, selectCompany, logout }),
    [status, user, isOffline, login, selectCompany, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
