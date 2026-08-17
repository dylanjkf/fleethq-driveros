# Offline storage & the plaintext-IndexedDB tradeoff

DriverOS is "offline-first, always": a driver mid-shift on a flaky connection
must never lose captured work. To make that guarantee, the app persists a
meaningful amount of state on the device. This document records exactly what is
stored, that it is stored **unencrypted**, and the deliberate reasons why —
together with the mitigations we use instead of client-side encryption.

## What is persisted on the device

Everything lives in a single IndexedDB database named `driveros`, managed by
[`src/lib/offline-db.ts`](../src/lib/offline-db.ts). Four object stores:

- **`outbox`** — completed mutations queued while offline, replayed in order on
  reconnect. These carry the heaviest personal data: **base64-encoded POD
  photos, recipient signatures, and fuel receipt images**, plus recipient names,
  notes, odometer readings and the last 4 digits of a fuel card.
- **`cache`** — last-known-good reads shown with an "offline — last synced"
  indicator: today's jobs including **customer names and delivery addresses**,
  glovebox documents, checklist templates, and — keyed `load-status-{jobId}` —
  each run's Confirm Load manifest and scan state (so a load verified in a dead
  zone keeps its scanned parcels across an app restart; see `src/api/load.ts` /
  `ConfirmLoadPage.tsx`).
- **`checklistDrafts`** — in-progress safety-checklist answers, saved on every
  keystroke so progress survives a mid-flow disconnect.
- **`deadLetter`** — mutations the server permanently rejected, held out of the
  outbox so one poison item can't block the queue, and surfaced for the driver
  to retry or discard.

## The data is stored PLAINTEXT

Image blobs (POD photos, signatures, fuel receipts) are stored as **plaintext
base64 strings**, and all other fields as plaintext JSON. **Nothing in the
`driveros` database is encrypted at rest on the device.** A person with
filesystem/OS access to the tablet (or browser devtools) can read it directly.

## Why this tradeoff was made deliberately

The unsynced `outbox` and `deadLetter` stores are **preserved across logout**
(see `clearSensitiveData`): a driver who captures a proof-of-delivery or a "broke
down, need help" message in a dead zone, then logs out or hands the tablet on,
must not have that un-transmitted work silently discarded — that would be its own
serious data-loss bug. Encrypting these blobs under a per-session key would mean
that key has to survive logout too (or the preserved work becomes undecryptable),
which defeats the point of encrypting it. We accept **plaintext residue on a
shared tablet** as the cost of never losing a driver's captured work on a bad
connection.

## Mitigations used instead of client-side encryption

- **Logout / 401 purge** — `clearSensitiveData` clears the re-fetchable `cache`
  (customer names, addresses, glovebox docs) and local `checklistDrafts` on
  explicit logout or a real 401, so a departing driver's personal/business data
  does not linger for the next user. (Unsynced `outbox`/`deadLetter` are
  deliberately kept — see above.)
- **Per-driver outbox ownership** — every queued mutation is tagged with the
  capturing driver's identity (JWT `sub`) via
  [`src/lib/session-identity.ts`](../src/lib/session-identity.ts), so preserved
  work is only ever replayed under the same driver who made it and is never
  attributed to whoever logs in next (security audit H2).
- **PIN app-lock** — `AppLockProvider` gates the whole app behind a
  device-configured PIN, so a picked-up tablet doesn't expose captured work in
  the UI without the PIN.
- **Image downscaling** — photos are compressed/downscaled before they ever
  reach state or the outbox (`src/lib/image.ts`), bounding how much image data
  is retained on the device.

## Note on the Privacy Policy

The Privacy Policy's "encryption at rest" statement refers to **server-side
storage (RDS / S3)**, NOT to the on-device IndexedDB described here. Device-side
offline state is plaintext, as documented above.
