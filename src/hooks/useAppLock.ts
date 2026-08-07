import { useContext } from 'react';
import { AppLockContext, type AppLockContextValue } from '@/app/providers/AppLockProvider';

/** Access the app-level PIN lock (security audit M4). Must be inside AppLockProvider. */
export function useAppLock(): AppLockContextValue {
  const ctx = useContext(AppLockContext);
  if (!ctx) throw new Error('useAppLock must be used within an AppLockProvider');
  return ctx;
}
