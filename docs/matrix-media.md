# Matrix images and files

The Matrix gateway accepts `m.image`, `m.file`, `m.audio`, and `m.video` messages.
Sender, room admission, mention, DM and thread rules are unchanged. In a group
that requires mentions, mention the agent in the attachment caption or send the
attachment in a thread the agent has already answered in.

Attachments are downloaded through the configured homeserver's authenticated
`/_matrix/client/v1/media/download` endpoint. Tokens are never sent directly to
the server named in an `mxc://` URI; redirects are refused. A homeserver supporting
authenticated media (Matrix 1.11+) is required. No unauthenticated legacy fallback
is attempted.

Files are stored atomically with mode `0600` in a directory created with `0700`.
The message handed to the agent contains a local absolute path and the original
(untrusted) attachment metadata. The agent can inspect images using its image-capable
read tool and process other files with its normal authorized tools. Attachments
are not embedded as base64 into the durable inbox or automatically executed.
Attachment messages are handed off individually, not merged by text batching.
Filenames beginning with `/` cannot become slash commands.

## Sending a file

The Matrix session's capability context explains the explicit output protocol:
include one standalone line per authorized local file in the final answer:

```text
Here is the requested report.
MEDIA:/absolute/path/report.pdf
```

The gateway removes the `MEDIA:` line and uploads the file. Known image extensions
(`png`, `jpg`, `jpeg`, `gif`, `webp`) are sent as `m.image`; other files use `m.file`.
The final text is delivered normally, including editable-progress replacement.
Attachments retain the destination thread. Progress messages do not trigger uploads.
Ordinary Markdown paths/links are not implicitly uploaded. Missing files and files
above the configured limit are permanent delivery failures, not silent text fallbacks.

Only send files the user authorized sharing with the **entire current Matrix room**.
This protocol is an outbound side effect, not a way to quote arbitrary `MEDIA:` lines.

## Encryption

Encrypted rooms use Matrix v2 encrypted attachments: AES-256-CTR with a fresh
random key and IV, SHA-256 ciphertext integrity verification, and the file
key/descriptor inside the existing Megolm-encrypted message. Encrypted uploads use
`application/octet-stream` and do not disclose the original filename in the upload
URL. If E2EE is unavailable, encrypted-room uploads fail before sending file bytes;
there is no plaintext downgrade. Incoming v2 attachments are verified before being
written locally. Plain attachments inside encrypted-room plaintext events continue
to be rejected by the room encryption policy.

## Settings and retention

- `MATRIX_MEDIA_DIR`: defaults to `<agent-home>/matrix-media`.
- `MATRIX_MEDIA_MAX_BYTES`: positive integer, defaults to **20 MiB per file**.
  Checked against announced sizes and actual streamed download bytes. Local uploads
  are bounded reads of regular files.

The media store is private local storage, **not encrypted at rest**. It deliberately
has no automatic expiry: queued/replayed inputs may still reference these paths.
Operators must manage disk space and remove files only when no retained/queued
conversation needs them. The per-file bound is not a total disk quota. Transfer
requests have a 60-second timeout. Failed/retried uploads may leave unreferenced
media on the homeserver; stable delivery transaction IDs avoid duplicate chat events.
Uploads are re-read on retry, so keep outbound source files unchanged until delivery.

## Development verification / activation boundary

Source changes span `plugins/src/matrix-channel.ts` and the core binary durable-write
helper/capability context. Core's `src/builtin-plugins` is generated; do not edit it.
`plugins.lock.json` pins the published attachment implementation and its SHA-256.
A normal build therefore materializes the reviewed implementation, not unpublished
workspace changes:

```sh
cd core
npm run build
npm run typecheck
node --import tsx --test test/matrix*.test.ts test/capability-context.test.ts
npm test
```

Coverage includes a real Olm/Megolm encrypted attachment roundtrip, tamper rejection,
ACL/admission, bounded transfers, filenames, threading and stable event transactions.
These are simulated homeserver tests, not evidence of live deployment. Runtime
activation uses the normal release/promotion process and fresh update admission;
a merged source PR alone does not establish live availability.
