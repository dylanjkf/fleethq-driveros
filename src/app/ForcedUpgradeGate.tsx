import { useEffect, useState, type ReactNode } from 'react';
import { setUpgradeRequiredHandler } from '@/api/client';

/**
 * Blocks the whole app when the server refuses this build as too old (HTTP 426
 * or an UPGRADE_REQUIRED code — see api/client.ts). An out-of-date DriverOS on a
 * field tablet could otherwise keep hitting incompatible APIs and silently
 * mis-record deliveries; a hard "please update" gate is the safe terminal state.
 * Wrapped OUTSIDE auth so even the login screen is blocked on a stale build.
 */
export function ForcedUpgradeGate({ children }: { children: ReactNode }) {
  const [upgradeRequired, setUpgradeRequired] = useState(false);

  useEffect(() => {
    setUpgradeRequiredHandler(() => setUpgradeRequired(true));
  }, []);

  if (!upgradeRequired) return <>{children}</>;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-(--surface-0) px-8 text-center">
      <h1 className="text-2xl font-bold">Update required</h1>
      <p className="max-w-sm text-(--text-secondary)">
        This version of DriverOS is out of date and can no longer sync with the office. Please update to the latest
        version to keep working.
      </p>
      <p className="text-sm text-(--text-tertiary)">Update from the App Store or Play Store, then reopen DriverOS.</p>
    </div>
  );
}
