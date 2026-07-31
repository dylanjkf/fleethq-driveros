import { useEffect, useRef } from 'react';
import { reportLocation, type LocationFix } from '@/api/locations';

// How often the tablet re-reports its last-known position. A heartbeat (rather
// than only-on-move) keeps the office's "last seen" fresh, so a stationary but
// online driver reads as online, not as "last seen 20 min ago".
const HEARTBEAT_MS = 45_000;

/**
 * While `active` (the operator is on shift), watches the device's geolocation
 * and reports the latest fix to the API on a heartbeat. Entirely best-effort
 * and non-blocking, per CLAUDE.md's "AI/enhancements never block a core
 * workflow": if geolocation is unavailable, permission is denied, or the app
 * is served over plain http (geolocation needs a secure context), this simply
 * reports nothing and the delivery flow is unaffected.
 */
export function useLocationReporter(active: boolean): void {
  const latest = useRef<LocationFix | null>(null);

  useEffect(() => {
    if (!active) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

    let cancelled = false;
    let reportedFirst = false;

    const flush = () => {
      if (cancelled || !latest.current) return;
      void reportLocation(latest.current).catch(() => {
        // best-effort — the next heartbeat retries
      });
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        latest.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy };
        // Push the very first fix straight away rather than waiting a heartbeat,
        // so the driver appears on the board within seconds of starting.
        if (!reportedFirst) {
          reportedFirst = true;
          flush();
        }
      },
      () => {
        // Denied / unavailable — stay silent; location is an enhancement.
      },
      { enableHighAccuracy: true, maximumAge: 30_000, timeout: 27_000 },
    );

    const heartbeat = window.setInterval(flush, HEARTBEAT_MS);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeat);
      navigator.geolocation.clearWatch(watchId);
    };
  }, [active]);
}
