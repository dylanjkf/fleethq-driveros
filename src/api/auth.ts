import { apiClient } from './client';
import type { CurrentUser, LoginResult } from './types';

export async function login(username: string, password: string): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResult>('/v1/auth/login', { username, password });
  return data;
}

export async function selectCompany(preAuthToken: string, companyId: string): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResult>('/v1/auth/select-company', { preAuthToken, companyId });
  return data;
}

/**
 * Set a new password after a login came back `password_expired`, completing that
 * same login. Hits the shared backend endpoint the office app uses; the returned
 * LoginResult carries the flow on (authenticated, or choose_company if the driver
 * belongs to several companies).
 */
export async function changeExpiredPassword(changeToken: string, newPassword: string): Promise<LoginResult> {
  const { data } = await apiClient.post<LoginResult>('/v1/auth/password-expired/change', { changeToken, newPassword });
  return data;
}

export async function getMe(): Promise<CurrentUser> {
  const { data } = await apiClient.get<CurrentUser>('/v1/auth/me');
  return data;
}

/**
 * Trigger the shared backend password-recovery service (the same
 * `POST /v1/auth/forgot-password` the office app uses — DriverOS drivers are the
 * same customer `User` accounts). Sends only the driver-entered identifier; the
 * endpoint is deliberately silent/non-enumerating and returns 200/204 whether or
 * not an account matched, so the caller MUST NOT branch on the response — see the
 * neutral-confirmation handling in LoginPage.
 *
 * This is an unauthenticated login-screen action, so it's a plain apiClient POST
 * with no offline outbox queueing: there's no session to attach and nothing to
 * reconcile later — if there's no signal the driver simply retries.
 */
export async function requestPasswordReset(identifier: string): Promise<void> {
  await apiClient.post('/v1/auth/forgot-password', { identifier });
}
