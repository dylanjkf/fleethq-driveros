import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useAppLock } from '@/hooks/useAppLock';

/**
 * Full-screen PIN gate shown when the app has auto-locked (security audit M4).
 * It blocks the underlying UI but does NOT log out — the session and the
 * offline outbox stay intact; a correct PIN returns the driver exactly where
 * they were. A "Sign out instead" escape hatch is offered for the case where a
 * different driver has picked up the device.
 */
export function LockScreen({ onSignOut }: { onSignOut: () => void }) {
  const { unlock } = useAppLock();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setChecking(true);
    setError(false);
    const ok = await unlock(pin);
    setChecking(false);
    if (!ok) {
      setError(true);
      setPin('');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-(--surface-0) px-8">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Device locked</h1>
        <p className="mt-2 text-(--text-secondary)">Enter your PIN to continue your shift.</p>
      </div>
      <form onSubmit={(e) => void submit(e)} className="flex w-full max-w-xs flex-col gap-4">
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          pattern="\d*"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          aria-label="PIN"
          aria-invalid={error}
          className="w-full rounded-2xl border border-(--border-subtle) bg-(--surface-1) px-6 py-4 text-center text-2xl tracking-[0.5em]"
        />
        {error && <p className="text-center text-sm font-semibold text-danger-500">Incorrect PIN. Try again.</p>}
        <Button type="submit" disabled={checking || pin.length < 4}>
          {checking ? 'Checking…' : 'Unlock'}
        </Button>
      </form>
      <button type="button" onClick={onSignOut} className="text-sm text-(--text-tertiary) underline">
        Not you? Sign out instead
      </button>
    </div>
  );
}
