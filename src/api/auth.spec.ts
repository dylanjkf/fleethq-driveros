import { describe, expect, it, vi, beforeEach } from 'vitest';
import { requestPasswordReset } from './auth';
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
