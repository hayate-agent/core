# Identified maintenance admission (host contract)

This is a host API, not a network endpoint. `ContextMaintenance.admit(key, id,
request, expectedVersion)` persists a compact/handover request without invoking
runtime maintenance. The caller must supply its own authorization and exact scope.
There is no new administrative credential or default listener.

Read `admissionStatus(key)` for the latest version (initially zero). New requests
must match that version; acceptance increments it. Retrying the latest identical
ID, payload and original expected version returns its acceptance receipt without
scheduling another operation. Reusing that ID with different data conflicts.
Older versions conflict after a newer request, so an unbounded ID history is not
required. IDs must not be intentionally reused with new versions. Admission rejects
while another ordinary pending/prepared operation exists; legacy requests cannot
overwrite identified pending work. For fenced recovery, a **new** ID at the current
version can explicitly reopen the same operation (retaining its lifetime failure
count and granting a new bounded epoch). Prepared handover recovery must retain
the saved preserve/resume payload, so a recovery grant cannot silently replace
already-checkpointed intent. An old identical acceptance retry does not reopen it. Uncertain compact/summary outcomes require an admitted handover
reconciliation, not a blind repeat compact. No new authorization is implied: only
already authorized callers of this host contract can admit recovery.

Acceptance is durable intent, **not successful execution**. Query the separate
execution status: pending, applied, failed, superseded or cancelled. Failed work
retains recovery intent; status omits preservation text, digests and raw errors.
It may additionally contain a `recovery` waiting/blocked hold with operation ID,
failed-attempt count, reason, and a fixed `notBefore` for waiting. See
[context-maintenance.md](context-maintenance.md#durable-recovery-fence).
An unrelated runtime session replacement supersedes optional pending identified
intent; mandatory/fenced intent is retained instead. Initial owner binding preserves it. Existing handover recovery retains its own
lifecycle. This does not promise arbitrary exactly-once runtime effects after a
crash or ambiguous persistence failure: reconcile actual effects before retrying.

`cancelAdmission(key, id, version)` retracts pending intent before prepared handover,
not already applied/failed effects. Repeated cancellation is idempotent. It does
not abort the working prompt. Pause, stop and owner shutdown do not themselves
cancel durable maintenance intent; explicit cancellation is separate. Maintenance
still needs an appropriate future owner boundary. No new prompt or scheduling wake
is created by admission. Status/admission serialize with maintenance, so they can
wait behind maintenance execution, even though an ordinary working prompt does
not block persistence.

An external writable transport, opt-in configuration and operator-facing receipt
flow remain a separate integration. This contract alone is not SSH/tmux-style
interactive attach or externally available administration.
