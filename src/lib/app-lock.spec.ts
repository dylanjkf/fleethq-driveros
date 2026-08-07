import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  disableLock,
  getLockTimeoutMs,
  isLockConfigured,
  isValidPin,
  recordActivity,
  setLockTimeoutMs,
  setPin,
  shouldAutoLock,
  verifyPin,
} from './app-lock';

/**
 * M4 core: the lock state machine (PIN hashing/verify + idle timeout). The
 * provider/LockScreen wire this into React; this proves the security-critical
 * logic — a wrong PIN never unlocks, and the app auto-locks after the timeout —
 * without a browser.
 */
describe('app-lock (M4)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is not configured and never auto-locks before a PIN is set', () => {
    expect(isLockConfigured()).toBe(false);
    expect(shouldAutoLock(Date.now())).toBe(false);
  });

  it('validates PIN format', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('123')).toBe(false); // too short
    expect(isValidPin('12ab')).toBe(false); // non-numeric
    expect(isValidPin('')).toBe(false);
  });

  it('accepts the correct PIN and rejects any other', async () => {
    await setPin('4821');
    expect(isLockConfigured()).toBe(true);
    expect(await verifyPin('4821')).toBe(true);
    expect(await verifyPin('4820')).toBe(false);
    expect(await verifyPin('0000')).toBe(false);
  });

  it('stores only a salted hash, never the PIN itself', async () => {
    await setPin('1379');
    const dump = JSON.stringify(localStorage);
    expect(dump).not.toContain('1379');
  });

  it('auto-locks only once the idle timeout has elapsed', async () => {
    const t0 = 1_000_000;
    await setPin('2468', t0); // records activity at t0
    expect(shouldAutoLock(t0)).toBe(false);
    expect(shouldAutoLock(t0 + DEFAULT_LOCK_TIMEOUT_MS - 1)).toBe(false);
    expect(shouldAutoLock(t0 + DEFAULT_LOCK_TIMEOUT_MS)).toBe(true);
  });

  it('recording activity pushes the auto-lock deadline forward', async () => {
    const t0 = 5_000_000;
    await setPin('1111', t0);
    const later = t0 + DEFAULT_LOCK_TIMEOUT_MS - 1;
    recordActivity(later);
    expect(shouldAutoLock(later)).toBe(false);
    expect(shouldAutoLock(later + DEFAULT_LOCK_TIMEOUT_MS)).toBe(true);
  });

  it('honours a custom timeout', async () => {
    setLockTimeoutMs(60_000);
    expect(getLockTimeoutMs()).toBe(60_000);
    const t0 = 9_000_000;
    await setPin('3333', t0);
    expect(shouldAutoLock(t0 + 59_999)).toBe(false);
    expect(shouldAutoLock(t0 + 60_000)).toBe(true);
  });

  it('disableLock clears all config', async () => {
    await setPin('7777');
    setLockTimeoutMs(60_000);
    disableLock();
    expect(isLockConfigured()).toBe(false);
    expect(await verifyPin('7777')).toBe(false);
    expect(shouldAutoLock(Date.now())).toBe(false);
  });
});
