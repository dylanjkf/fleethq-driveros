import { tokenStore } from '@/api/token-store';

/**
 * Owner tag for outbox items whose capturing identity is unknown — used to
 * backfill items that were queued before ownership tagging existed (the
 * IndexedDB v4→v5 migration). It can never equal a real user id, so such items
 * are always treated as "not the current driver's" and are held rather than
 * silently replayed under whoever logs in next.
 */
export const UNKNOWN_OWNER = '__unknown_owner__';

/**
 * The identity that "owns" work captured on this shared device right now: the
 * `sub` (user id) of the currently stored access token. DriverOS runs on shared
 * tablets and deliberately preserves the offline outbox across logout, so a
 * captured mutation must be tagged with who made it and only ever replayed under
 * that same identity (security audit H2 — cross-driver replay).
 *
 * Reads the JWT payload without verifying it — verification is the server's job;
 * here we only need the caller's own `sub` to tag/scope local work, and it must
 * work fully offline. Returns null when there's no token (logged out) or the
 * token is malformed.
 */
export function currentOwnerId(): string | null {
  const token = tokenStore.get();
  if (!token) return null;
  return ownerIdFromToken(token);
}

/** Decode a JWT's `sub` claim (unverified). Exported for tests. */
export function ownerIdFromToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { sub?: unknown };
    return typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null;
  } catch {
    return null;
  }
}
