import axios, { type AxiosError } from 'axios';
import { tokenStore } from './token-store';
import type { ApiErrorBody } from './types';

/** Normalized client-side error — status 0 means "no response at all" (offline/network failure), never a real server verdict. */
export class ApiClientError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Same cross-origin reasoning as apps/fleethq's client.ts: DriverOS and the
 * API are separate deployables (a native app shell has no "origin" to share
 * with the API at all), so `VITE_API_BASE` — baked in at build time, see
 * capacitor.config.ts's own comment — must be an absolute URL for any real
 * build, e.g. `https://api.fleethq.online`. Unset falls back to `/`, which
 * Vite's dev server proxies to `http://localhost:3000` — correct for local
 * web dev only, never for a Capacitor build (there is no dev proxy inside a
 * native WebView).
 *
 * `timeout` matters more here than in the office app: DriverOS runs at the edge
 * of coverage, and a POST that hangs on a marginal link would otherwise stall
 * the whole outbox drain indefinitely (the drain holds a lock for the duration
 * of each request). A bounded timeout turns that hang into a normal status-0
 * failure the sync engine can classify and retry, instead of a frozen queue.
 */
export const apiClient = axios.create({ baseURL: import.meta.env.VITE_API_BASE || '/', timeout: 30_000 });

apiClient.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status ?? 0;
    const body = error.response?.data?.error;

    // Only a real 401 clears the session — a network failure (status 0,
    // e.g. offline) must never look like an invalid login, per DriverOS's
    // "offline-first, always" non-negotiable (CLAUDE.md).
    if (status === 401) {
      tokenStore.clear();
      onUnauthorized?.();
    }

    const { code = 'NETWORK_ERROR', message = error.message, ...details } = body ?? {};
    return Promise.reject(new ApiClientError(status, code, message, details));
  },
);
