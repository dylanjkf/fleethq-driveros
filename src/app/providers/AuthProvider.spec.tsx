/**
 * Round 4 — AuthProvider logout / 401 orchestration.
 *
 * These are the shared-tablet data-remanence guarantees, so their *ordering* is
 * the thing under test, not just that the calls happen:
 *  - logout tears down the push subscription while the token is still valid
 *    (server-side unsubscribe needs auth), THEN clears the token, THEN wipes the
 *    local caches.
 *  - a confirmed 401 awaits the same purge (it is no longer fire-and-forget).
 */
import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useContext } from 'react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AuthContext, AuthProvider } from './AuthProvider';

// A single ordered log every mocked side-effect appends to, so tests can assert
// the exact sequence rather than just that each call happened.
const calls: string[] = [];

vi.mock('@/api/token-store', () => ({
  tokenStore: {
    get: vi.fn(() => null),
    set: vi.fn(),
    clear: vi.fn(() => calls.push('token.clear')),
  },
}));
vi.mock('@/lib/offline-db', () => ({
  getCache: vi.fn(async () => null),
  setCache: vi.fn(async () => undefined),
  clearSensitiveData: vi.fn(async () => {
    calls.push('clearSensitiveData');
  }),
}));
vi.mock('@/lib/push-registration', () => ({
  disablePushNotifications: vi.fn(async () => {
    calls.push('disablePush');
  }),
}));

let captured401Handler: (() => void | Promise<void>) | null = null;
vi.mock('@/api/client', () => ({
  setUnauthorizedHandler: vi.fn((h: () => void | Promise<void>) => {
    captured401Handler = h;
  }),
}));
vi.mock('@/api/auth', () => ({
  login: vi.fn(),
  selectCompany: vi.fn(),
}));

function Consumer() {
  const ctx = useContext(AuthContext)!;
  return (
    <div>
      <span data-testid="status">{ctx.status}</span>
      <button onClick={() => void ctx.logout()}>logout</button>
    </div>
  );
}

function renderProvider() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const clearSpy = vi.spyOn(queryClient, 'clear');
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Consumer />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { clearSpy };
}

describe('AuthProvider logout / 401 orchestration', () => {
  beforeEach(() => {
    calls.length = 0;
    captured401Handler = null;
  });

  it('logout unsubscribes push BEFORE clearing the token, then wipes local caches', async () => {
    renderProvider();
    await act(async () => {
      screen.getByText('logout').click();
      // let the async logout settle
      await Promise.resolve();
      await Promise.resolve();
    });

    // push teardown must run while the token is still valid, i.e. before token.clear
    expect(calls.indexOf('disablePush')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('disablePush')).toBeLessThan(calls.indexOf('token.clear'));
    // local IndexedDB wipe happens after the token is cleared
    expect(calls.indexOf('token.clear')).toBeLessThan(calls.indexOf('clearSensitiveData'));
    expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
  });

  it('registers a 401 handler that awaits the purge and ends the session', async () => {
    renderProvider();
    expect(captured401Handler).toBeTypeOf('function');

    await act(async () => {
      await captured401Handler!();
    });

    // the 401 purge tears down push + IndexedDB and lands unauthenticated
    expect(calls).toContain('disablePush');
    expect(calls).toContain('clearSensitiveData');
    expect(screen.getByTestId('status').textContent).toBe('unauthenticated');
  });
});
