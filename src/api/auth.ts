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

export async function getMe(): Promise<CurrentUser> {
  const { data } = await apiClient.get<CurrentUser>('/v1/auth/me');
  return data;
}
