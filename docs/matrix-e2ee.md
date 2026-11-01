# Native Matrix encryption

Matrix uses `@matrix-org/matrix-sdk-crypto-nodejs` (Rust SDK OlmMachine, SQLite),
not JavaScript/home-made cryptography. Encryption is enabled by default.

## Configuration

- `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (device-bound) or
  `MATRIX_USER_ID` / `MATRIX_PASSWORD`: existing authentication.
- `MATRIX_DEVICE_ID`: stable device ID matching the token. Normally obtained from
  `/account/whoami` or password login. Startup refuses E2EE if no device ID is
  available or if a configured ID disagrees with the server.
- `MATRIX_E2EE=true`: default. `false` supports plaintext rooms only; it **does
  not** permit plaintext replies to encrypted rooms.
- `MATRIX_CRYPTO_STORE_DIR`: default `<harness-home>/matrix-crypto`. Keep it on a
  private, durable local filesystem (WSL: Linux home, not a shared `/mnt/c`
  directory). The directory is 0700; identity and pending ciphertext files are
  0600. Native SQLite keys are protected by directory permissions, not a store
  passphrase. Use full-disk encryption and private backups for at-rest protection.

Install with normal `npm ci` (do not disable dependency install scripts): the
native library's postinstall downloads the platform binary. If dependencies were
installed with `--ignore-scripts`, run `npm rebuild @matrix-org/matrix-sdk-crypto-nodejs`.
Linux/WSL target binary availability must be checked on that target.

Never share a store between processes or clone it to a second active device.
The store is bound to exact homeserver, MXID and device ID and rejects reuse for
another identity. Keep the session, sync checkpoint and crypto directory together
across restart. Losing the crypto directory loses that device's decryptable keys;
do not remove it as a troubleshooting shortcut.

## Security and behavior

- Sync feeds to-device events, changed/left devices, OTK counts and fallback-key
  counts into the machine. Requests use SDK transaction IDs and are acknowledged
  only after successful HTTP responses; partial key failures stop sending.
- Every text path, including progress seeds/edits and native activity, sends
  `m.room.encrypted` in encrypted rooms. State lookup errors and unsupported
  encryption algorithms stop delivery. Known encryption is sticky across restart.
- Joined membership is refreshed before each send and tracked devices are updated.
  Sessions rotate **every message** because the Node binding currently has no
  explicit group-session invalidation API. This costs extra key-sharing traffic
  but prevents a departed member retaining the next outbound session key.
- Sync and gap backfill include encrypted events. Undecryptable ciphertext is
  stored separately before cursor advancement and retried after later sync/key
  updates and restart, without the normal poison-event retry limit. It is removed
  only after durable harness handoff. There is no automatic expiry or quota:
  monitor disk usage for hostile/unrecoverable events.
- Decryption preserves server sender/event ID/timestamp, verifies sender and room
  consistency and rejects unknown/unestablished sender authenticity. Existing
  user/room/mention/approval ACLs still apply. Plaintext text/commands in an
  encrypted room are rejected. Decrypted messages bypass text batching so pending
  ciphertext is not removed ahead of durable input handoff.
- Matrix-standard reactions, receipts, typing and room metadata are not encrypted;
  status reactions remain opt-in. Do not enable them if metadata disclosure is
  unacceptable.

## Limits and acceptance

No cross-signing/SAS verification UI, secret storage, recovery-key import, server
key backup or manual historical key-request workflow is implemented. Unknown
sender devices remain queued until device data/keys are available. Unverified but
known devices are accepted; this is not a verified-devices-only policy. New device
history depends on peers sharing the relevant keys. First startup retains the
existing skip-history behavior while consuming crypto sync data.

Real Olm/Megolm tests exercise two devices, OTK claims, encrypted to-device room
key sharing, decryption, SQLite reopen, delayed-key queue across channel restart,
ACL/envelope preservation, threads, encrypted progress edits and fail-closed
sending. They use an in-memory homeserver transport, not fabricated cryptography.
They do not prove live federation, Windows/WSL binary compatibility or deployment
acceptance. Obtain independent security review and a live two-client encrypted
room acceptance before release.

For unpublished plugin candidates, generate a **local** lock with hashes for all
locked plugin files plus `matrix-crypto.ts`; do not change the immutable release
lock to claim an unpublished revision. Then run:

```
node scripts/materialize-plugins.mjs ../vanillacore-matrix-e2ee-plugins /absolute/path/to/local-lock.json
npm run typecheck --ignore-scripts
npm test --ignore-scripts
npm run build --ignore-scripts
```

`--ignore-scripts` here skips the core's pretest/pretypecheck/prebuild re-download
of released plugins; it is **not** the dependency installation instruction above.
Release owners must publish the reviewed plugin revision and update the core's
revision/hashes in a separate release step.
