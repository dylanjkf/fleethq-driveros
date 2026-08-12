# DriverOS

FleetHQ's field/driver app — offline-first by design. React + TypeScript +
Vite, installable as a PWA today, and wrapped natively with Capacitor for the
App Store / Google Play.

Split out of [`fleethq-platform`](https://github.com/dylanjkf/fleethq-platform)
into its own repo so native iOS/Android builds and app-store CI/release
tooling can live independently of the API's release cadence. The product
specification (`FleetOS-Playbook/04-DriverOS/`) and the backend it talks to
still live in `fleethq-platform`.

## Local development

```bash
npm install
npm run dev           # http://localhost:5173, proxies /v1 and /health to
                       # http://localhost:3000 — run fleethq-platform/api
                       # locally alongside this (see its README)
npm run dev:lan        # same, over HTTPS and LAN-reachable, for testing on a
                       # real tablet (PWA/service worker need a secure context)
npm run build
npm run lint
npm test
```

## Environment variables

See `.env.example`. `VITE_API_BASE` must be set to the deployed API's
absolute URL (e.g. `https://api.fleethq.online`) for any build that isn't
local dev — there is no same-origin fallback once this ships as a native app
or a separately-hosted PWA build.

## Native app packaging (Capacitor)

The web app is wrapped, unmodified, in a native iOS/Android shell via
[Capacitor](https://capacitorjs.com) — see `capacitor.config.ts`. The
one-time toolchain setup (`npm run app:setup`) has already been run: the
`@capacitor/core`/`ios`/`android` packages are installed and the `ios/` and
`android/` native project directories exist and are wired to this app's
`dist/` build.

```bash
npm run app:sync    # rebuild the web app and copy it into ios/ and android/
npm run app:ios      # app:sync, then open the Xcode project (needs macOS + Xcode)
npm run app:android  # app:sync, then open the Android Studio project
```

**What's done**: the native projects exist and are build-configured against
this app's `dist/` build. CI (`.github/workflows/ci.yml`) verifies the web app
only — it runs lint, the TypeScript typecheck + Vite build, and the unit tests.
It does NOT run `cap sync` or any native (iOS/Android) build, so the Capacitor
sync step is a manual/local one (`npm run app:sync`), not something CI checks.

**What still needs a human with the right toolchain** — none of this can be
done from a Linux CI/sandbox environment:
- **iOS**: an Apple Developer Program membership, a macOS machine with
  Xcode to open `ios/App/App.xcworkspace`, CocoaPods (`pod install` in
  `ios/App`), code signing (a provisioning profile + certificate), and an App
  Store Connect listing (screenshots, privacy policy URL, review submission).
- **Android**: Android Studio to open `android/`, a signing keystore, and a
  Google Play Console developer account + listing (screenshots, content
  rating, data safety form, review submission).
- Before either store build, set `VITE_API_BASE` to the production API URL
  and run `npm run app:sync` so the native shell bundles the production
  build, not a dev one.

See `fleethq-platform`'s `FleetOS-Playbook/04-DriverOS/App_Packaging.md` for
the full packaging and store-submission checklist.

## Camera barcode/QR scanning

The stop screen (`src/features/delivery/StopPage.tsx`) scans parcels three ways
that all funnel through the **one** server-side matching path
(`scanStopParcel` → `POST …/parcels/scan`, offline-capable via `postOrQueue`):

- the manual text input (HID/Bluetooth scanner, or typed by hand) — **always
  available**, never hidden behind an error;
- a **"Scan with camera"** button using the native ML Kit scanner.

Both entry points call `submitScannedReference` (`src/features/delivery/
scan-submit.ts`); there is no second matching path. The camera wrapper is
`src/lib/barcode-scanner.ts`.

**Plugin choice:** `@capacitor-mlkit/barcode-scanning@8.1.0` (native), chosen
over a web `BarcodeDetector`-in-webview fallback because it publishes a
Capacitor-8-compatible release (peer `@capacitor/core >=8.0.0`; we run 8.4.2)
and the native ML Kit scanner decodes far better on real devices. Requires
`npx cap sync` before a device build (adds the plugin to the iOS/Android
projects). Camera permission strings are already declared (iOS
`NSCameraUsageDescription`, Android `android.permission.CAMERA`). On Android the
ML Kit scanner module is fetched on-demand by Play services on first scan. On
the plain web build (dev in a browser, no native shell) the button reports
"needs the installed app" and manual entry stays the path.

**Manual device-test procedure** (camera can't be unit-tested in CI — no
device):

1. `npm run app:sync` (or `npm run app:ios` / `npm run app:android`), build to a
   real device, open a stop from Today.
2. Tap **Scan with camera**, accept the camera permission prompt, point at a
   parcel barcode/QR → it appears in the Parcels list as "✓ Scanned" and the
   `x/y scanned` counter increments (same result as typing the code).
3. **Permission denied:** delete/deny camera access in OS settings, tap the
   button → "Camera access is off…" message shows and the manual input still
   works.
4. **No-read:** point at a blank/poorly-lit surface and back out → "Couldn't
   read a barcode…" (or nothing on cancel); manual entry unaffected.
5. **Unknown code:** scan a barcode not on the manifest → it goes through
   `scanStopParcel`; the server's response governs (unknown refs handled there).
6. **Offline:** enable airplane mode, scan → parcel shows optimistically and the
   scan queues to the outbox (`{ queued: true }`), replaying on reconnect.

## Release versioning

`package.json` `version` is the single source of truth for the marketing
version (currently `1.0.0`). Each store release must set the native
marketing/build numbers from it, and the build number must increase
monotonically or the store rejects the upload:

| Platform | Marketing version | Build number (must increment every upload) |
|----------|-------------------|--------------------------------------------|
| Android  | `versionName` in `android/app/build.gradle` = `package.json` version | `versionCode` = previous + 1 |
| iOS      | `MARKETING_VERSION` in the Xcode project = `package.json` version | `CURRENT_PROJECT_VERSION` = previous + 1 |

Process for a release: bump `package.json` `version` (semver), set
`versionName` / `MARKETING_VERSION` to match, bump `versionCode` /
`CURRENT_PROJECT_VERSION` to one above the last uploaded build, then
`npm run app:sync` and archive. The placeholders shipped in the repo
(`versionCode 1` / `versionName "1.0"` / `MARKETING_VERSION 1.0`) are the
first-release starting point.

## Orientation

The PWA no longer force-locks portrait (`manifest.webmanifest`
`"orientation": "any"`) so a tablet mounted in a cab can run landscape. The
page shells are single-column flex layouts that reflow acceptably in
landscape; a tablet-optimised multi-column layout for the wider breakpoints
is a tracked follow-up, not a blocker for landscape use.
