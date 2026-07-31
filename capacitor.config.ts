import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the already-built DriverOS web app (the Vite `dist/`) in a
 * native iOS/Android shell so it can ship to the App Store and Google Play as
 * a real downloadable app — no rewrite, the same PWA runs inside a WebView.
 *
 * See FleetOS-Playbook/04-DriverOS/App_Packaging.md for the full
 * build/publish flow. The Capacitor toolchain is installed and the ios/ and
 * android/ native projects already exist (`npm run app:setup` has been run —
 * see README.md "Native app packaging").
 */
const config: CapacitorConfig = {
  appId: 'com.fleetos.driveros',
  appName: 'DriverOS',
  webDir: 'dist',
  backgroundColor: '#0d0f16',
  server: {
    // In-app content is served from the bundled build. The app talks to the
    // FleetOS API over HTTPS at runtime (set VITE_API_BASE for store builds so
    // it points at production rather than a dev proxy).
    androidScheme: 'https',
    iosScheme: 'https',
  },
  ios: {
    contentInset: 'always',
  },
  android: {
    // Matches the PWA's dark chrome so the splash/status bar don't flash white.
    backgroundColor: '#0d0f16',
  },
};

export default config;
