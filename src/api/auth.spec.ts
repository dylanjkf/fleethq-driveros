import { describe, expect, it, vi, beforeEach } from 'vitest';
import { requestPasswordReset, login, getOrCreateDeviceFingerprint } from './auth';
import { apiClient } from './client';

// The forgot-password call is an unauthenticated login-screen action; the only
// thing worth pinning is that it hits the shared backend endpoint with exactly
// the driver-entered identifier, and that it deliberately ignores the response
// body (the endpoint is silent/non-enumerating, so the client must not read
// account state out of it).
vi.mock('./client', () => ({
  apiClient: { post: vi.fn() },
  ApiClientError: class ApiClientError extends Error {},
}));

const mockedPost = vi.mocked(apiClient.post);

describe('requestPasswordReset', () => {
  beforeEach(() => {
    mockedPost.mockReset();
  });

  it('POSTs the identifier to the shared /v1/auth/forgot-password endpoint', async () => {
    mockedPost.mockResolvedValue({ status: 204, data: undefined });

    await requestPasswordReset('driver.jones');

    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(mockedPost).toHaveBeenCalledWith('/v1/auth/forgot-password', { identifier: 'driver.jones' });
  });

  it('resolves without surfacing whether an account matched (non-enumerating)', async () => {
    // Whatever the endpoint returns, the function resolves to void — the caller
    // gets no signal it could use to disclose account existence.
    mockedPost.mockResolvedValue({ status: 200, data: { anything: true } });

    await expect(requestPasswordReset('someone@example.com')).resolves.toBeUndefined();
  });
});

describe('device fingerprint (A3 — stable per-tablet id so alerts are scoped)', () => {
  beforeEach(() => {
    mockedPost.mockReset();
    localStorage.clear();
  });

  it('is generated once and stays STABLE across calls (persisted in localStorage)', () => {
    const first = getOrCreateDeviceFingerprint();
    const second = getOrCreateDeviceFingerprint();
    expect(first).toBe(second);
    expect(localStorage.getItem('fleethq.driveros.deviceFingerprint')).toBe(first);
  });

  it('login sends that stable fingerprint, so repeat shifts are the SAME device (not a new one each time)', async () => {
    mockedPost.mockResolvedValue({ status: 200, data: { status: 'authenticated', accessToken: 'a', company: { id: 'c', name: 'Co' } } });

    await login('driver.jones', 'pw');
    await login('driver.jones', 'pw'); // a later shift, same tablet

    const fp = localStorage.getItem('fleethq.driveros.deviceFingerprint');
    expect(fp).toBeTruthy();
    for (const call of mockedPost.mock.calls) {
      expect(call[0]).toBe('/v1/auth/login');
      expect((call[1] as { deviceFingerprint: string }).deviceFingerprint).toBe(fp);
    }
  });
});
