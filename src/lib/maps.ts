/**
 * Opens a stop's address in whatever maps app the device has (Google Maps on
 * Android, Apple/Google Maps on iOS, the browser elsewhere) via the universal
 * Google Maps URL scheme. Purely a hand-off — DriverOS itself has no embedded
 * map/turn-by-turn (05-Dispatch/Dispatch_Overview.md keeps in-app routing out
 * of scope); this just saves the driver retyping the address into their maps
 * app for every stop.
 */
export function directionsUrl(destination: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}`;
}
