import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useAppLock } from '@/hooks/useAppLock';
import { isValidPin, LOCK_TIMEOUT_OPTIONS_MS } from '@/lib/app-lock';

/**
 * Optional device-lock control (security audit M4), surfaced near Sign out.
 * Lets a driver enable a PIN that re-gates the app after an idle/background
 * timeout — protecting an active session on a shared tablet without the heavy
 * hammer of a full logout (which discards unsynced work).
 */
export function LockSettings() {
  const { configured, timeoutMs, configurePin, removeLock, lockNow, setTimeoutMs } = useAppLock();
  const [setup, setSetup] = useState(false);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!isValidPin(pin)) return setError('PIN must be at least 4 digits.');
    if (pin !== confirm) return setError('The PINs don’t match.');
    await configurePin(pin);
    setSetup(false);
    setPin('');
    setConfirm('');
    setError(null);
  }

  if (configured) {
    return (
      <div className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4 text-left">
        <p className="font-semibold">Device lock is on</p>
        <p className="mt-1 text-sm text-(--text-secondary)">
          Locks after inactivity — your shift and unsynced work stay put.
        </p>
        <label className="mt-3 block text-sm text-(--text-secondary)">
          Lock after
          <select
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(Number(e.target.value))}
            className="ml-2 rounded-lg border border-(--border-subtle) bg-(--surface-2) px-2 py-1"
          >
            {LOCK_TIMEOUT_OPTIONS_MS.map((ms) => (
              <option key={ms} value={ms}>
                {ms / 60_000} min
              </option>
            ))}
          </select>
        </label>
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" onClick={lockNow} className="text-base">
            Lock now
          </Button>
          <Button variant="secondary" onClick={removeLock} className="text-base">
            Turn off
          </Button>
        </div>
      </div>
    );
  }

  if (!setup) {
    return (
      <button type="button" onClick={() => setSetup(true)} className="text-sm text-(--text-tertiary) underline">
        Set up a device lock (PIN)
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-(--border-subtle) bg-(--surface-1) p-4 text-left">
      <p className="font-semibold">Set a device PIN</p>
      <input
        type="password"
        inputMode="numeric"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        placeholder="New PIN"
        aria-label="New PIN"
        className="mt-3 w-full rounded-xl border border-(--border-subtle) bg-(--surface-2) px-4 py-3 text-center text-xl tracking-[0.4em]"
      />
      <input
        type="password"
        inputMode="numeric"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
        placeholder="Confirm PIN"
        aria-label="Confirm PIN"
        className="mt-2 w-full rounded-xl border border-(--border-subtle) bg-(--surface-2) px-4 py-3 text-center text-xl tracking-[0.4em]"
      />
      {error && <p className="mt-2 text-sm font-semibold text-danger-500">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button onClick={() => void save()} className="text-base">
          Save PIN
        </Button>
        <Button variant="secondary" onClick={() => setSetup(false)} className="text-base">
          Cancel
        </Button>
      </div>
    </div>
  );
}
