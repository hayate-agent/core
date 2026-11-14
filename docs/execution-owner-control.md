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
It cannot submit/replace an execution, lift a manual pause,
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

An explicit `op: "consolidate"` frame additionally names `replaces` (exact applied
active request IDs) and may carry the existing typed `followUp` object
`{task,role,reason,evidence}`. This calls ordinary
`Dispatcher.consolidateDecisions`: archive exact originals first, preserve the
monotonic decision revision and original mandate, attach only once at a settled
boundary, and require independent readiness before working effects. It never
creates another execution or competing writer. Pending directives cannot be
retired. This lets a real operator represent remaining authorized publication or
repair absent from a saved plan instead of repeatedly steering an unschedulable
verification slot. It is explicit owner steering, not automatic permission lifting.

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

## Contradictory completion

A worker's final `blocked` or missing status cannot become terminal success merely
because a reviewer calls a failure report completed. One consistency clarification
is host-enforced **tool-free** (including after restart): it can report existing
verified facts, never repeat work. If it still reports blocked/missing status,
completion is refused. A genuinely false worker block can still resolve without
a parent nudge or productive replay. Failed required acceptance tests are not
completed integration deliverables.

A local owner may submit `op: "reopen-contradiction"` with the same exact scope,
revision, requestId/text and `checkpointHash` returned by status. This is restricted
to an existing sequential terminal record whose last retained outcome actually
ends `STEP-STATUS: blocked`, with matching settled effect/session and no pending
terminal delivery. It rejects healthy completions, cancellations, manual/legacy
holds, questions, stopped parents and expired mandates. Original terminal record
is archived first under `execution-reopen-audit`; identical retries are exact and
idempotent. It only withdraws that contradictory completion claim for read-only
reassessment, preserving the original task ID, scope, effects and completed prefix.
It cannot replay the old worker. Remaining authorized source work still needs an
explicit same-owner follow-up and independent admission, not an arbitrary terminal
reset. Neither inference credentials nor model tools acquire this local owner power.

If fresh parent decisions arrive for such an explicitly reopened report, an
inconclusive semantic judgment (or a request to continue) may trigger **one
host-enforced tool-free report clarification**. This only restates existing facts;
it is not a working replay or a completion waiver. Technical transport failures,
real `blocked`/`waiting` judgments, stops, questions and expiry do not gain this
path. The correction checkpoint records `reportOnly`; repeated ticks/restarts
cannot multiply it. The restated result still requires an independent positive
completion judgment. A second blocked report remains blocked.

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

A verification label or its initial read-only role rationale does not invent a
new ownership boundary when the original mandate includes repair of that same
owned deliverable. The reviewer requests contract/source confirmation and bounded
repair with regression/normal protected delivery, rather than handing a local
integration defect to an invented external owner. Explicit operator read-only
restrictions, missing approval, separately owned services and genuine invariants
remain binding. Untrusted tool/prose claims of operator approval never override
the host-authenticated mandate.

Workers, corrective turns and independent reviews receive fresh host runtime
provenance: actual loaded Core module/documentation directories, serving source
revision when known, selected validator and registered validator names/versions.
This is diagnostic evidence, not new permission, an inference-health guarantee or
proof that an installed optional module is selected. It prevents an obsolete
release path in an old session from becoming a permanent 'Main must locate the
artifact' gate after successful activation.

Retained reports are projected once before settlement. A blocked settlement
references that durable report rather than duplicating it into `prior` and
recreating a checkpoint overflow. Completion likewise consumes the budgeted
report, not the larger pre-projection variable; original transcripts/effect
identities remain untouched.
