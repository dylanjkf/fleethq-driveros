import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tokenStore } from '@/api/token-store';
import {
  disableLock,
  getLockTimeoutMs,
  isLockConfigured,
  recordActivity,
  setLockTimeoutMs as persistLockTimeoutMs,
  setPin,
  shouldAutoLock,
  verifyPin,
} from '@/lib/app-lock';

export interface AppLockContextValue {
  /** A PIN lock is configured for this session. */
  configured: boolean;
  /** The UI is currently locked and must be re-authenticated with the PIN. */
  locked: boolean;
  timeoutMs: number;
  /** Verify the PIN and unlock; returns false on a wrong PIN. */
  unlock: (pin: string) => Promise<boolean>;
  /** Set (or replace) the PIN — enables the lock. */
  configurePin: (pin: string) => Promise<void>;
  /** Turn the lock off for this session. */
  removeLock: () => void;
  /** Lock right now (e.g. a "lock this device" button). */
  lockNow: () => void;
  setTimeoutMs: (ms: number) => void;
}

// eslint-disable-next-line react-refresh/only-export-components
export const AppLockContext = createContext<AppLockContextValue | null>(null);

/** How often to re-check idle state while the app is foregrounded. */
const IDLE_POLL_MS = 15_000;

export function AppLockProvider({ children }: { children: ReactNode }) {
  const [configured, setConfigured] = useState(isLockConfigured());
  const [locked, setLocked] = useState(() => isLockConfigured() && shouldAutoLock());
  const [timeoutMs, setTimeoutMsState] = useState(getLockTimeoutMs());
  // Avoid stamping activity on every pointer move — throttle to once/sec.
  const lastStamp = useRef(0);

  const maybeLock = useCallback(() => {
    if (isLockConfigured() && shouldAutoLock()) setLocked(true);
  }, []);

  useEffect(() => {
    if (!configured) return;

    const onActivity = () => {
      if (locked) return; // a locked screen's taps must not refresh the timer
      const now = Date.now();
      if (now - lastStamp.current > 1_000) {
        lastStamp.current = now;
        recordActivity(now);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        if (!locked) recordActivity(); // freeze the countdown from when we backgrounded
      } else {
        maybeLock(); // returning to foreground: lock if the timeout elapsed while away
      }
    };

    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity);
    document.addEventListener('visibilitychange', onVisibility);
    const interval = window.setInterval(maybeLock, IDLE_POLL_MS);
    return () => {
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearInterval(interval);
    };
  }, [configured, locked, maybeLock]);

  const unlock = useCallback(async (pin: string) => {
    const ok = await verifyPin(pin);
    if (ok) {
      recordActivity();
      setLocked(false);
    }
    return ok;
  }, []);

  const configurePin = useCallback(async (pin: string) => {
    await setPin(pin);
    setConfigured(true);
    setLocked(false);
  }, []);

  const removeLock = useCallback(() => {
    disableLock();
    setConfigured(false);
    setLocked(false);
  }, []);

  const lockNow = useCallback(() => {
    if (isLockConfigured()) setLocked(true);
  }, []);

  const setTimeoutMs = useCallback((ms: number) => {
    persistLockTimeoutMs(ms);
    setTimeoutMsState(ms);
  }, []);

  // Tie the lock lifecycle to the session: when the token clears (explicit
  // logout or a confirmed-dead 401), the departing driver's PIN is no longer
  // relevant — clear it so the next driver starts unlocked with no carried-over
  // PIN. The session/outbox themselves are handled by AuthProvider.
  useEffect(() => {
    return tokenStore.subscribe((token) => {
      if (token === null) {
        disableLock();
        setConfigured(false);
        setLocked(false);
      }
    });
  }, []);

  const value = useMemo<AppLockContextValue>(
    () => ({ configured, locked, timeoutMs, unlock, configurePin, removeLock, lockNow, setTimeoutMs }),
    [configured, locked, timeoutMs, unlock, configurePin, removeLock, lockNow, setTimeoutMs],
  );

  return <AppLockContext.Provider value={value}>{children}</AppLockContext.Provider>;
}
