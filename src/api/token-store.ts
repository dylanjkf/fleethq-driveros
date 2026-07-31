const STORAGE_KEY = 'driveros.accessToken';

type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();

/** Same pattern as apps/fleethq's token-store.ts — kept out of React state so the axios client can read it directly. */
export const tokenStore = {
  get(): string | null {
    return localStorage.getItem(STORAGE_KEY);
  },
  set(token: string): void {
    localStorage.setItem(STORAGE_KEY, token);
    listeners.forEach((l) => l(token));
  },
  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
    listeners.forEach((l) => l(null));
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
