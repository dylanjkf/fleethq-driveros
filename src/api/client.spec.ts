import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Client interceptors — the 401 teardown ORDER (Part 7 item 2) and the
 * forced-upgrade / version-header wiring (Part 7 item 3).
 */
const calls: string[] = [];
vi.mock('./token-store', () => ({
  tokenStore: {
    get: vi.fn(() => 'valid-token'),
    set: vi.fn(),
    clear: vi.fn(() => calls.push('token.clear')),
  },
}));

import { apiClient, setUnauthorizedHandler, setUpgradeRequiredHandler } from './client';

/** A mock success response so a request resolves through the interceptors. */
function ok(config: unknown) {
  return { data: {}, status: 200, statusText: 'OK', headers: {}, config } as never;
}

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client — version header (Part 7 item 3)', () => {
  it('sends X-App-Version on every request', async () => {
    let sentVersion: unknown;
    apiClient.defaults.adapter = vi.fn(async (config) => {
      sentVersion = config.headers['X-App-Version'];
      return ok(config);
    });

    await apiClient.get('/anything');
    expect(sentVersion).toBeDefined();
    expect(typeof sentVersion).toBe('string');
  });
});

describe('api client — forced upgrade (Part 7 item 3)', () => {
  it('fires the upgrade handler on a 426 Upgrade Required', async () => {
    const onUpgrade = vi.fn();
    setUpgradeRequiredHandler(onUpgrade);
    apiClient.defaults.adapter = vi.fn(async () => {
      throw { response: { status: 426, data: { error: { code: 'UPGRADE_REQUIRED', message: 'too old' } } } };
    });

    await apiClient.get('/anything').catch(() => undefined);
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });
});

describe('api client — 401 teardown order (Part 7 item 2)', () => {
  it('runs the session purge (push unsubscribe) BEFORE clearing the token', async () => {
    // The registered handler stands in for AuthProvider's purge (which unsubscribes
    // push while the token is still valid). We assert the token is cleared only
    // after it resolves.
    setUnauthorizedHandler(async () => {
      calls.push('onUnauthorized');
    });
    // /me re-check returns 401 → session genuinely dead.
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 401 }) as Response));
    apiClient.defaults.adapter = vi.fn(async () => {
      throw { response: { status: 401, data: { error: { code: 'UNAUTHORIZED', message: 'nope' } } } };
    });

    await apiClient.get('/anything').catch(() => undefined);

    // confirmAndHandleUnauthorized runs async (fire-and-forget from the interceptor).
    await vi.waitFor(() => expect(calls).toContain('token.clear'));
    expect(calls).toContain('onUnauthorized');
    expect(calls.indexOf('onUnauthorized')).toBeLessThan(calls.indexOf('token.clear'));
  });
});
