# Native gateway discovery and explicit messages

`plugin_message` is a transport-neutral tool for installed gateways that explicitly
opt in via `Channel.messaging`. It is available with the default tool selection
and is added to nonempty selections; an explicit empty selection still disables
all model tools. Main and workers receive the current live gateway capabilities
on each turn, not a promise inferred from environment variables, desired config
or an installed-but-inactive module. This adds no credentials or permissions.

- `{"action":"status"}`: live installed gateways and their messaging capabilities.
- `{"action":"destinations","gateway":"slack","limit":50}`: a bounded page of
  destinations; follow `nextCursor` using `cursor`. Names are untrusted data.
- `{"action":"send","gateway":"slack","target":"C123", "text":"Authorized text", "requestId":"operator-task-message-1"}`:
  one explicitly authorized send. Omit `thread` for a new post; include the exact
  provider thread ID for a reply. Use exact IDs rather than guessed channel names.
- `{"action":"send","gateway":"slack","target":"C123","file":{"path":"reports/result.pdf","name":"result.pdf"},"text":"Optional caption","requestId":"operator-task-file-1"}`:
  one explicitly authorized file send. Files can also be sent in DMs or existing
  threads; `thread` is optional.
- `{"action":"receipt","requestId":"operator-task-message-1"}`: this conversation's
  retained outcome.

The current operator mandate must authorize message, audience and destination.
A connected gateway, destination listing, or channel membership is not authority.
Do not fetch tokens or use shell HTTP clients as a substitute for this native tool.
Adapters still enforce their own allowlists and destination validation. Console,
API and other channels do not become send targets merely because they implement
reply delivery; the gateway must explicitly provide `messaging`.

## Binary files and images

Adapters advertise `files` and `maxFileBytes` in live capabilities. File content
is read only from a regular, non-symlink file under the current execution workspace
or the originating conversation's own inbound attachment directory. Other agent
storage, foreign conversation attachments, hidden credential trees and paths
outside the workspace are rejected. One file per send, at most 10 MiB; empty
files are allowed. Filename is validated separately and never used as a local
storage path. Images and arbitrary binary bytes use the same file transfer path;
there is no shell/Base64 workaround or automatic interpretation of uploaded data.

Before external I/O, Core snapshots and hashes the bytes in origin-scoped storage.
Destination changes cannot relabel ownership. The adapter rechecks hash and size.
The caption, destination, filename and file fingerprint participate in the logical
request identity, and identical retained sends are not uploaded again. Unknown
upload/completion effects stay uncertain and require external reconciliation.
A changed source file with the same request ID is rejected. Retain the source
file (or use the immutable staged blob) when querying/repeating a send; `receipt`
does not need the source file. Selecting an exportable file still requires the
operator's mandate; workspace containment is not permission to disclose data.

Access/mention rules are independent: see [conversation policies](conversation-policy.md).

## Receipt and retry semantics

An exclusive private receipt under `<home>/message-receipts/` is flushed before
external delivery. It stores destination, request ID, fingerprint and status,
not message contents (file sends also retain the origin-scoped attachment reference). Identity is scoped to the originating conversation and
logical request ID. Identical retries return the retained result, including after
a process restart; conflicting text/destination with the same ID is rejected.

`delivered` means the transport accepted the send, not that a human read it.
A failed or interrupted attempt is `uncertain` and is never automatically resent.
Inspect the external destination before deciding whether a separately authorized
new send is needed. This is at-most-one automatic attempt per retained receipt,
not exactly-once remote delivery. A provider error may happen before sending or
after a side effect; the generic tool conservatively does not infer which.
Do not delete receipts to force retries. Receipts are not automatically pruned;
monitor disk usage and preserve them across runtime updates.

## Gateway opt-in

A trusted adapter may expose `channel.messaging` with:

- synchronous `describe()`: `text`, optional `threads`/`connected`,
  `destinationFormat`, optional `workspace` and `allowedTargets` (no tokens);
- optional asynchronous `destinations({limit,cursor}, signal)`: bounded destination
  records `{target,name?,kind?}` and optional `nextCursor`.

Sending still goes through the existing Harness delivery fence and `Channel.send`,
with a stable delivery ID. Discovery must be lifecycle-owned and honor stop and
cancellation. No unrestricted raw provider API, workspace history import, contact
harvesting, membership changes or automatic channel joining is exposed.
