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
an owner reason. Trusted custom gateway factories may likewise declare
`updateAdmission: "foreground-owned"` on their GatewayModule. Construction must
be inert, every producer/delivery must use host-owned ingress/outbox work, and
Channel.stop must abort and drain remaining sync/retry/crypto resources. The host
tracks the actual active instance (not desired settings); preparation and pending
or running replacement block admission. A failed activation after attempted
replacement leaves an irreversible process-local cleanup uncertainty blocker:
restoring an old channel does not prove candidate resources were stopped. No
settings change clears this blocker; runtime-owner reconciliation is required.
Legacy factories remain unsupported.
This assertion is not an audit or a sandbox. Policy/extension/reloadable tool
modules still lack this contract and return explicit unavailable reasons;
this does not disable supported core-only admission.

## Optional WebUI ownership

The separately installed WebUI plugin implements the existing foreground-owned
contract as both a native gateway and, optionally, a settings-tool plugin. Core
needs no transport-specific exemption. Browser/SSE connections are idle resources;
actual agent work enters through host ingress/tools. The owner fences new input,
closes sockets (including incomplete requests), drains entered host acceptance and
presentation writes/refresh, then awaits module cleanup. Failed cleanup rejects
shutdown/restart rather than declaring successful quiescence.

UI modules must themselves explicitly assert foreground ownership and register
resource cleanup; undeclared modules fail before activation. The assertion is
trusted code, not validation that arbitrary JS is safe. Host work, approvals,
pending delivery and unsupported unrelated plugins retain their normal blockers.
See the [WebUI setup](gateways.md#2-browser-install-and-activate-the-webui-plugin)
and its plugin guide for the exact module contract and tested limits.

An older already-running prototype remains unsupported until an **explicitly
authorized maintenance transition** restarts its owner with the new module.
Changing files, reloading only the gateway, or observing no other blockers does
not retroactively opt its startup PluginHost into admission. Never manufacture a
lease, suppress blockers or remove security checks to perform that transition.

## Managed Matrix recovery module

The shipped `docs/gateways/matrix-recovery.mjs` is the managed version of the
20261026 recovery gateway. It preserves both bounded Matrix429 retry/backoff and
review audit-summary compaction; it inherits native Matrix stop/ingress/outbox
ownership. Use its absolute installed path `/opt/hayate-agent/docs/gateways/matrix-recovery.mjs`
in gatewayPlugins.matrix.module through the normal reviewed configuration owner.
Do not copy it into an old install to claim old-process admission: old CLI code
unconditionally rejects any custom gateway. Its closure cannot be hot-patched by
reloading a module. Transitioning such an original process requires the existing
runtime owner's separately authorized bootstrap/maintenance route; a release or
GET idle is not permission to stop. Never remove the custom gateway simply to
manufacture admission. This change supplies the contract for the next boot, not
an override endpoint or an old-process lease. No live configuration or
credentials are changed by this feature.
