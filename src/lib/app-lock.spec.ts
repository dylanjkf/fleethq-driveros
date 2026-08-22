import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  disableLock,
  getLockoutState,
  getLockTimeoutMs,
  isLockConfigured,
  isValidPin,
  MAX_PIN_ATTEMPTS,
  PIN_LOCKOUT_MS,
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

  describe('PIN attempt lockout', () => {
    it('locks out after MAX_PIN_ATTEMPTS wrong entries and then refuses even the correct PIN', async () => {
      const t0 = 1_000_000;
      await setPin('4821', t0);

      // Wrong attempts up to the cap.
      for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) {
        expect(await verifyPin('0000', t0)).toBe(false);
      }

      // Now locked out — even the CORRECT PIN is refused (this is what bounds brute force).
      const state = getLockoutState(t0);
      expect(state.lockedOut).toBe(true);
      expect(state.until).toBe(t0 + PIN_LOCKOUT_MS);
      expect(await verifyPin('4821', t0)).toBe(false);
    });

    it('lets the correct PIN through once the lockout window has elapsed', async () => {
      const t0 = 2_000_000;
      await setPin('4821', t0);
      for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) await verifyPin('0000', t0);
      expect(getLockoutState(t0).lockedOut).toBe(true);

      // Still locked one ms before the window ends...
      expect(await verifyPin('4821', t0 + PIN_LOCKOUT_MS - 1)).toBe(false);
      // ...and unlocked the moment it elapses.
      const after = t0 + PIN_LOCKOUT_MS;
      expect(getLockoutState(after).lockedOut).toBe(false);
      expect(await verifyPin('4821', after)).toBe(true);
    });

    it('a correct PIN resets the failed-attempt counter (no lockout from spread-out mistakes)', async () => {
      const t0 = 3_000_000;
      await setPin('4821', t0);
      // Fewer than the cap, then a success clears the count.
      await verifyPin('0000', t0);
      await verifyPin('0000', t0);
      expect(await verifyPin('4821', t0)).toBe(true);
      // A fresh run of wrong attempts starts from zero — the earlier two don't carry over.
      for (let i = 0; i < MAX_PIN_ATTEMPTS - 1; i++) expect(await verifyPin('0000', t0)).toBe(false);
      expect(getLockoutState(t0).lockedOut).toBe(false);
    });

    it('disableLock also clears an active lockout', async () => {
      const t0 = 4_000_000;
      await setPin('4821', t0);
      for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) await verifyPin('0000', t0);
      expect(getLockoutState(t0).lockedOut).toBe(true);
      disableLock();
      expect(getLockoutState(t0).lockedOut).toBe(false);
    });
  });
});
