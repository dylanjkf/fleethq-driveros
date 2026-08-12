import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AppLockProvider } from './AppLockProvider';
import { useAppLock } from '@/hooks/useAppLock';
import { setPin, disableLock, DEFAULT_LOCK_TIMEOUT_MS } from '@/lib/app-lock';

// A controllable token store so the provider's "clear the PIN when the token
// clears" subscription can be triggered on demand — mirrors sync-engine.spec.ts.
const tokenState = vi.hoisted(() => {
  const listeners = new Set<(t: string | null) => void>();
  return {
    current: null as string | null,
    listeners,
    emit(t: string | null) {
      listeners.forEach((l) => l(t));
    },
  };
});
vi.mock('@/api/token-store', () => ({
  tokenStore: {
    get: () => tokenState.current,
    set: (t: string) => {
      tokenState.current = t;
      tokenState.emit(t);
    },
    clear: () => {
      tokenState.current = null;
      tokenState.emit(null);
    },
    subscribe: (l: (t: string | null) => void) => {
      tokenState.listeners.add(l);
      return () => tokenState.listeners.delete(l);
    },
  },
}));

// Surfaces the lock context so tests can read state and drive unlock().
let ctx: ReturnType<typeof useAppLock>;
function Probe() {
  ctx = useAppLock();
  return (
    <div>
      <span data-testid="configured">{String(ctx.configured)}</span>
      <span data-testid="locked">{String(ctx.locked)}</span>
    </div>
  );
}

function renderProvider() {
  render(
    <AppLockProvider>
      <Probe />
    </AppLockProvider>,
  );
}

describe('AppLockProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    disableLock();
    tokenState.current = null;
    tokenState.listeners.clear();
  });

  it('starts unlocked when no PIN is configured', () => {
    renderProvider();
    expect(screen.getByTestId('configured').textContent).toBe('false');
    expect(screen.getByTestId('locked').textContent).toBe('false');
  });

  it('mounts locked when a PIN is configured and the idle timeout has elapsed', async () => {
    // Configure a PIN whose last activity is well past the timeout, so
    // shouldAutoLock() is true at mount.
    await setPin('1234', Date.now() - DEFAULT_LOCK_TIMEOUT_MS - 60_000);
    renderProvider();
    expect(screen.getByTestId('configured').textContent).toBe('true');
    expect(screen.getByTestId('locked').textContent).toBe('true');
  });

  it('unlocks with the correct PIN and rejects a wrong one', async () => {
    await setPin('1234', Date.now() - DEFAULT_LOCK_TIMEOUT_MS - 60_000);
    renderProvider();
    expect(screen.getByTestId('locked').textContent).toBe('true');

    let wrong: boolean | undefined;
    await act(async () => {
      wrong = await ctx.unlock('9999');
    });
    expect(wrong).toBe(false);
    expect(screen.getByTestId('locked').textContent).toBe('true');

    let right: boolean | undefined;
    await act(async () => {
      right = await ctx.unlock('1234');
    });
    expect(right).toBe(true);
    expect(screen.getByTestId('locked').textContent).toBe('false');
  });

  it('clears PIN/lock state when the token clears (logout / dead 401)', async () => {
    await setPin('1234', Date.now() - DEFAULT_LOCK_TIMEOUT_MS - 60_000);
    renderProvider();
    expect(screen.getByTestId('configured').textContent).toBe('true');

    await act(async () => {
      tokenState.emit(null); // subscription fires on a cleared token
    });
    expect(screen.getByTestId('configured').textContent).toBe('false');
    expect(screen.getByTestId('locked').textContent).toBe('false');
  });
});
