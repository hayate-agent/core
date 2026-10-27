# Opt-in local context maintenance control

This is a separate writable local endpoint, not an upgrade of the read-only
observer or Hermes run API. It supports compact/handover requests, not arbitrary
commands, shell execution, transcript access or provider replacement.

Start the owner explicitly with both options:

```sh
vanillacore-harness run --maintenance-directory /private/path --maintenance-session 'exact:key'
```

No listener is enabled by default. The owner fixes the key; clients cannot choose
another conversation or supply console/admin identities. The directory must be a
real same-UID-owned directory with mode 0700 (created if absent); maintenance.sock
has mode 0600. Same OS account is the trust boundary, not network authentication.
Do not forward it to untrusted users. Existing socket paths are never removed to
force startup. Stop cleans up its owned endpoint and leaves the private directory.

## Protocol

One JSON line per Unix-socket connection, maximum 20000 bytes, at most sixteen
connections/in-flight operations, five-second socket inactivity timeout. Responses
are JSON lines. Invalid/failed requests return a generic rejection; query status
and reconcile before retrying an uncertain/disconnected admission.

```json
{"op":"status"}
{"op":"admit","id":"maintenance-1","version":0,"request":{"action":"compact","preserve":"operator intent","resume":"continue tests"}}
{"op":"cancel","id":"maintenance-1","version":1}
```

Use the dedicated CLI without starting another runtime or acquiring a home lock:

```sh
vanillacore-harness maintenance /private/path/maintenance.sock status
vanillacore-harness maintenance /private/path/maintenance.sock admit maintenance-1 0 request.json
vanillacore-harness maintenance /private/path/maintenance.sock cancel maintenance-1 1
```

`request.json` contains only `action`, `preserve`, and `resume`. The client reads a
bounded regular file rather than putting maintenance text in process arguments.
It validates and projects receipt fields, limits responses to 4096 bytes and waits
at most ten seconds. Server rejection or malformed responses produce a nonzero
exit. Ctrl+C aborts waiting, not an already accepted operation. There is no automatic
mutation retry: after timeout/disconnect, reconcile status and reuse the original
ID/version only when appropriate. Output `state: accepted` is a persistence receipt,
not successful execution. The raw JSON protocol remains available to local clients.

Send each protocol example on a separate connection.
`status` returns the sanitized latest receipt/version. Admission returns only after
persistence, independently of a running working prompt and its reply outbox. It
is not proof of execution. See [maintenance-admission.md](maintenance-admission.md)
for CAS retries, cancellation and execution states. Requests have a fixed scope;
additional fields, including alternate session keys, are rejected.

A one-second, non-overlapping owner tick attempts already-pending maintenance on
an existing opened idle session. Busy, paused, stopping or queued owners defer it.
No working/model turn is created and unknown sessions are not opened. Operator
input arriving during reservation takes precedence before effects begin. Handover
may itself call runtime summarization; no claim of model-free maintenance is made.
Failure remains visible in the receipt; polling does not reset failed requests or
bypass cooldown. Stop/shutdown is best effort once an effect has started, not hard
cancellation or rollback. Durable intent survives restart; stop/pause does not
implicitly retract it. Shutdown drains entered requests and maintenance; trusted
runtime operations can hang. Changes/builds do not activate listeners without
explicit owner startup configuration. No other agent is reconfigured by this work.
