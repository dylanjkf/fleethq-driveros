/**
 * App-level re-lock (security audit M4). DriverOS runs on shared field tablets;
 * a full logout wipes the session and unsynced outbox, which is too heavy for a
 * driver who just set the tablet down for a minute. This adds an OPTIONAL,
 * lightweight lock that re-gates the UI behind a PIN after an idle/background
 * timeout WITHOUT discarding the session or the offline outbox.
 *
 * First pass: a numeric PIN (a biometric unlock via a Capacitor plugin is a
 * natural follow-up — the provider's unlock path is the single seam to add it).
 * The PIN is stored only as a salted SHA-256 hash. This is not a defence against
 * a determined attacker with a rooted device and a debugger (the access token
 * already lives in local storage) — it's a shared-device-handoff deterrent, the
 * exact gap the audit flagged. Lock config is per-session and cleared on logout.
 */
const PIN_HASH_KEY = 'driveros.lock.pinHash';
const SALT_KEY = 'driveros.lock.salt';
const TIMEOUT_KEY = 'driveros.lock.timeoutMs';
const LAST_ACTIVE_KEY = 'driveros.lock.lastActive';
const FAILED_ATTEMPTS_KEY = 'driveros.lock.failedAttempts';
const LOCKOUT_UNTIL_KEY = 'driveros.lock.lockoutUntil';

/** Default idle/background timeout before the app re-locks. */
export const DEFAULT_LOCK_TIMEOUT_MS = 2 * 60_000;
/** Allowed timeout choices surfaced in the UI. */
export const LOCK_TIMEOUT_OPTIONS_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000];
const MIN_PIN_LENGTH = 4;

/** Consecutive wrong-PIN attempts allowed before a timed lockout kicks in. */
export const MAX_PIN_ATTEMPTS = 5;
/** How long PIN entry is refused after MAX_PIN_ATTEMPTS consecutive failures. */
export const PIN_LOCKOUT_MS = 60_000;

export interface LockoutState {
  /** True while PIN entry is refused. */
  lockedOut: boolean;
  /** ms timestamp the lockout ends, or null when not locked out. */
  until: number | null;
  /** Wrong attempts remaining before the next lockout. */
  attemptsRemaining: number;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPin(pin: string, saltHex: string): Promise<string> {
  const data = new TextEncoder().encode(`${saltHex}:${pin}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

/** Whether a PIN lock is currently configured for this session. */
export function isLockConfigured(): boolean {
  return !!localStorage.getItem(PIN_HASH_KEY) && !!localStorage.getItem(SALT_KEY);
}

export function isValidPin(pin: string): boolean {
  return /^\d+$/.test(pin) && pin.length >= MIN_PIN_LENGTH;
}

/** Set (or replace) the PIN and mark the app active so it doesn't immediately re-lock. */
export async function setPin(pin: string, at: number = Date.now()): Promise<void> {
  if (!isValidPin(pin)) throw new Error(`PIN must be at least ${MIN_PIN_LENGTH} digits.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = toHex(salt.buffer);
  localStorage.setItem(SALT_KEY, saltHex);
  localStorage.setItem(PIN_HASH_KEY, await hashPin(pin, saltHex));
  recordActivity(at);
}

function readInt(key: string): number {
  const raw = Number(localStorage.getItem(key));
  return Number.isFinite(raw) ? raw : 0;
}

/**
 * Current lockout state — drives the LockScreen's "too many attempts" message
 * and disabled entry, and gates verifyPin below.
 */
export function getLockoutState(now: number = Date.now()): LockoutState {
  const until = readInt(LOCKOUT_UNTIL_KEY);
  if (until > now) return { lockedOut: true, until, attemptsRemaining: 0 };
  const failed = readInt(FAILED_ATTEMPTS_KEY);
  return { lockedOut: false, until: null, attemptsRemaining: Math.max(0, MAX_PIN_ATTEMPTS - failed) };
}

function clearLockoutState(): void {
  localStorage.removeItem(FAILED_ATTEMPTS_KEY);
  localStorage.removeItem(LOCKOUT_UNTIL_KEY);
}

/**
 * Check a candidate PIN against the stored hash, with brute-force lockout.
 * Without a cap the numeric PIN (as few as 4 digits) is trivially guessable by
 * repeated entry on a shared tablet. After MAX_PIN_ATTEMPTS consecutive wrong
 * entries, PIN entry is refused for PIN_LOCKOUT_MS; a locked-out attempt is not
 * even hashed. A correct PIN clears the counter and any lockout. `now` is
 * injectable for deterministic tests.
 */
export async function verifyPin(pin: string, now: number = Date.now()): Promise<boolean> {
  // Locked out: refuse without counting (the counter already tripped the lock).
  if (getLockoutState(now).lockedOut) return false;

  const saltHex = localStorage.getItem(SALT_KEY);
  const stored = localStorage.getItem(PIN_HASH_KEY);
  if (!saltHex || !stored) return false;

  if ((await hashPin(pin, saltHex)) === stored) {
    clearLockoutState(); // correct PIN → fresh slate
    return true;
  }

  // Wrong PIN: count it, and start a timed lockout once the cap is reached.
  const failed = readInt(FAILED_ATTEMPTS_KEY) + 1;
  if (failed >= MAX_PIN_ATTEMPTS) {
    localStorage.setItem(LOCKOUT_UNTIL_KEY, String(now + PIN_LOCKOUT_MS));
    localStorage.removeItem(FAILED_ATTEMPTS_KEY); // fresh set of attempts once the lockout elapses
  } else {
    localStorage.setItem(FAILED_ATTEMPTS_KEY, String(failed));
  }
  return false;
}

/** Remove all lock config (on logout, or when the driver disables the lock). */
export function disableLock(): void {
  localStorage.removeItem(PIN_HASH_KEY);
  localStorage.removeItem(SALT_KEY);
  localStorage.removeItem(TIMEOUT_KEY);
  localStorage.removeItem(LAST_ACTIVE_KEY);
  clearLockoutState();
}

export function getLockTimeoutMs(): number {
  const raw = Number(localStorage.getItem(TIMEOUT_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LOCK_TIMEOUT_MS;
}

export function setLockTimeoutMs(ms: number): void {
  localStorage.setItem(TIMEOUT_KEY, String(ms));
}

/** Stamp "the user was active now" — resets the idle countdown. */
export function recordActivity(at: number = Date.now()): void {
  localStorage.setItem(LAST_ACTIVE_KEY, String(at));
}

/**
 * Whether the app should auto-lock: a PIN is configured and more than the
 * timeout has elapsed since the last recorded activity. With no recorded
 * activity yet, it errs toward locked (fail-safe).
 */
export function shouldAutoLock(now: number = Date.now()): boolean {
  if (!isLockConfigured()) return false;
  const raw = localStorage.getItem(LAST_ACTIVE_KEY);
  if (raw === null) return true;
  const last = Number(raw);
  if (!Number.isFinite(last)) return true;
  return now - last >= getLockTimeoutMs();
}
