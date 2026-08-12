import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ownerIdFromToken, currentOwnerId } from './session-identity';

// A controllable token so currentOwnerId (which reads the token store) can be
// exercised without touching localStorage — mirrors sync-engine.spec.ts.
const tokenState = vi.hoisted(() => ({ current: null as string | null }));
vi.mock('@/api/token-store', () => ({
  tokenStore: {
    get: () => tokenState.current,
    set: (t: string) => {
      tokenState.current = t;
    },
    clear: () => {
      tokenState.current = null;
    },
    subscribe: () => () => {},
  },
}));

/** Build a JWT-shaped string whose payload carries the given claims (base64url,
 *  unsigned — only the payload matters to the decoder under test). */
function tokenWithPayload(payload: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${b64}.signature`;
}

describe('ownerIdFromToken', () => {
  it('returns the `sub` claim of a valid JWT', () => {
    expect(ownerIdFromToken(tokenWithPayload({ sub: 'driver-123' }))).toBe('driver-123');
  });

  it('decodes base64url payloads across lengths that need padding', () => {
    for (const id of ['a', 'ab', 'abc', 'abcd', 'driver-with-a-longer-id']) {
      expect(ownerIdFromToken(tokenWithPayload({ sub: id }))).toBe(id);
    }
  });

  it('returns null for a string with no dot-separated payload', () => {
    expect(ownerIdFromToken('not-a-jwt')).toBeNull();
  });

  it('returns null when the payload segment is not decodable base64/JSON', () => {
    expect(ownerIdFromToken('header.!!!not-base64!!!.sig')).toBeNull();
  });

  it('returns null when the `sub` claim is absent', () => {
    expect(ownerIdFromToken(tokenWithPayload({ name: 'Ada' }))).toBeNull();
  });

  it('returns null when `sub` is empty or not a string', () => {
    expect(ownerIdFromToken(tokenWithPayload({ sub: '' }))).toBeNull();
    expect(ownerIdFromToken(tokenWithPayload({ sub: 42 }))).toBeNull();
  });
});

describe('currentOwnerId', () => {
  beforeEach(() => {
    tokenState.current = null;
  });

  it('returns null when logged out (no stored token)', () => {
    expect(currentOwnerId()).toBeNull();
  });

  it('returns the stored token sub when signed in', () => {
    tokenState.current = tokenWithPayload({ sub: 'driver-999' });
    expect(currentOwnerId()).toBe('driver-999');
  });

  it('returns null for a malformed stored token', () => {
    // NOTE: the null is turned into the UNKNOWN_OWNER sentinel at the queueMutation
    // call site (currentOwnerId() ?? UNKNOWN_OWNER), not here — this function's
    // own contract is "the sub, or null".
    tokenState.current = 'garbage-token';
    expect(currentOwnerId()).toBeNull();
  });
});
