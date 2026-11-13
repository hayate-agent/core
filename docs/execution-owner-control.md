# Native execution-owner reconciliation

A configured Dispatcher exposes a **local process-owner-only** Unix socket at
the socket named by `<agent-home>/operator-control/owner.json`. The private
atomic pointer names a unique socket for the current process. Its directory is
mode 0700 and its
socket mode 0600, owned by the native runtime UID. This is deliberately the same
local filesystem trust boundary as native lifecycle maintenance, **not** an
inference API, dashboard route, model tool or permission granted by an API key.
It does not provide isolation from arbitrary programs already running as that
UID. Do not expose/forward the socket or grant its directory to untrusted users.
No channel, network credential, integration or admin setting is enabled by it.

Use it when an operator must reconcile new verified facts or clarify a temporary
phase restriction in an **existing** execution without hand-editing live state,
creating another business writer or impersonating a parent conversation through
an inference session. It calls the ordinary Dispatcher decision path: original
scope, decision limits, claim fencing and independent admission remain binding.
It cannot submit/replace work, consolidate directives, lift a manual pause,
answer a question, cancel, extend expiry or reactivate held legacy work.

One UTF-8 JSON frame terminated by newline is accepted per connection (maximum
8000 wire bytes). A status request names both exact scope components:

```json
{"op":"status","id":"<execution UUID>","parent":"<exact parent key>"}
```

After reconciling the current revision, an operator decision is:

```json
{"op":"decide","id":"<execution UUID>","parent":"<exact parent key>","expectedRevision":20,"requestId":"operator-reconciliation-v1","text":"Verified fresh facts and an explicitly scoped continuation within the original mandate; preserve original permissions and unknown effects."}
```

The text limit is 4000 UTF-8 bytes. `expectedRevision` is checked atomically inside
the serialized store commit; concurrent steering requires reinspection. Exact
request-ID/text retries return the existing receipt without duplicating it or
waking work again. A lost connection is NOT evidence of failure: reconcile using
the same identity, never invent another request to repeat an uncertain effect.
A receipt explicitly says `executionStarted: false`: recorded steering is not
proof of independent admission, working execution or completed effects. Verify
actual original task/step identity, tool observations and outcome separately.

The host drains accepted requests and removes only its own socket inode during
graceful shutdown. Unsafe directory ownership/permissions fail closed. Unique endpoints permit restart after a process crash without unlinking an
unknown socket; the private pointer is atomically replaced. Native lifecycle
single-owner locking remains responsible for preventing two agent processes.

## Step evidence and phase scope

Parent decisions retain their revision and typed follow-up metadata in both
working and review context. Slice-local restrictions must not become invented
permanent bans on other work, but an explicit global prohibition or unresolved
operator deferral never disappears automatically. Corrections always carry the
fresh original mandate and exact current step, even when a restored worker
session contains old business/phase reports.

The independent step reviewer distinguishes a true permission/prerequisite hold
from missing knowledge that authorized discovery can obtain. An absent local
process/configuration does not prove remote service absence. Reclassifying a
cached report does not refresh an external dependency. The reviewer must request
a concrete bounded safe read-only observation when one exists; it must not infer
an endpoint, credentials, completion or authorization for later effects.

Retained reports are projected once before settlement. A blocked settlement
references that durable report rather than duplicating it into `prior` and
recreating a checkpoint overflow. Completion likewise consumes the budgeted
report, not the larger pre-projection variable; original transcripts/effect
identities remain untouched.
