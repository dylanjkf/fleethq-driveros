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

**What's done**: the native projects exist, build-configured, and sync
correctly with the web build (verified in CI — see
`.github/workflows/ci.yml`).

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
