# Host update admission

The native HTTP API exposes `/v1/update-admission`, authenticated with the same
Bearer credential as `/v1/runs`. It neither installs an update nor stops a process.
HEX owns installation, signals and supervisor integration.

- `GET`: 200 with `{status, blockers, lease_id?, expires_at?}`. Status is `idle`,
  `busy`, `leased`, or `unavailable`. This read is diagnostic, not permission to stop.
- `POST {"ttl_ms":60000}`: atomically assess foreground idle and fence new work.
  TTL defaults to 60000ms; integer range 1000–300000ms. 201 returns
  `{status:"admitted", blockers:[], lease_id, expires_at}` (Unix epoch milliseconds).
  Busy/existing lease returns 409; unsupported owners/shutdown return 503;
  malformed input returns 400. Busy acquisition does not fence, pause, cancel,
  resolve approvals or stop anything. Retry after existing work finishes.
- `DELETE {"lease_id":"..."}`: 200 only for the current unexpired lease; stale,
  expired or foreign IDs return 409 without affecting another lease.

After 201, invoke the existing SIGTERM shutdown **before expires_at**, retaining a
margin for transport/signal delay. There is no renewal or stop endpoint. A lease
is process-local, exclusive and not durable across restart. Expiry/release clears
only that reservation; it never clears user pause, host transitions or shutdown.
No timer is required: every producer checks expiry synchronously before admission.
If time is insufficient, release/reacquire rather than signal on an expired receipt.
Do not treat a historical 201 or a GET of idle as enduring authorization.

## Ownership and safety boundary

Assessment includes running/queued turns, durable inbox acceptance/handoffs,
commands, unsaved completion/outbox entries, deliveries, pending approvals,
foreground producer reservations and dispatcher submissions/claims/tasks/events.
Scheduler scripts reserve ownership before spawning until output has been routed;
report processing, nightly producer ticks, API model lookup/record creation and
harness ticks reserve before their first await. A successful lease is established
without an intervening await. New channel input rejects before deduplication or
acknowledgement, allowing upstream redelivery. Scheduler/nightly/heartbeat work
is deferred, not launched. Existing work is never cancelled to obtain idle.

Ordered SIGTERM cleanup remains authoritative: producer shutdown, harness drain,
state persistence, memory provider close, extensions/policies/session-provider
close, reverse plugin cleanup, home ownership release. MemoryProviderLifecycle
waits for leased calls and connection creation before close; LocalMemory owns the
worker/lock and closes its worker. Ordinary reindexing/capture and idle runtime
resources need not implement reversible drain and do not themselves veto admission.
Admission is **not** proof that arbitrary unmanaged processes are idle, nor a
replacement for waiting for old-process exit before replacing the installation.
Existing shutdown failure handling/budgets remain unchanged.

Core Pi runtime and audited bundled plugins/gateway paths are supported. External
startup PluginModule owners may explicitly declare
`updateAdmission: "foreground-owned"`: all active work must run through host-owned
turns/tools or ingress; remaining resources must have ordered `onStop` cleanup.
This is a trusted-owner assertion, not a sandbox or inferred safety guarantee.
Legacy external plugins remain usable but make update admission unavailable with
an owner reason. Independently loaded custom gateway/policy/extension/reloadable
tool modules currently lack that contract and return explicit unavailable reasons;
this does not disable supported core-only admission. No live configuration or
credentials are changed by this feature.
