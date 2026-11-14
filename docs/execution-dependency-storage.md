# Execution dependency snapshots: v2 persistence

The live Minerva ledger reached 33,554,414 bytes, 18 bytes below the existing
32MiB cap: 825 executions, 781 completed, zero pending events; dependency snapshots
alone accounted for 27,728,991 bytes. This is a separate ledger from host state.
Do not raise the cap, clear ledgers, resume stopped work or delete effect receipts
as an emergency workaround.

Version2 keeps the same atomic ledger transaction for task transitions, outgoing
events, wait-denial receipts and turn settlements. Dependency JSON snapshots at
least4096 encoded UTF-8 bytes move to immutable private checksummed files under
`executions.json.dependencies`. Each binds exact execution ID and parent. The
published manifest references them; all referenced bytes and their directories
must be durable before manifest replacement. In-memory Execution/ledger API stays
version1. Hydration preserves JSON property order as well as values, because
recovery fences hash exact JSON serialization. No task/effect/budget field is
semantically changed; small dependencies remain inline.

First migration retains exact mode0600 `executions.json.legacy-v1` before any
manifest replacement. A conflicting existing backup fails closed rather than
overwriting audit evidence. **Blind binary rollback or restoring an old v1 backup
is unsupported**: it can lose newer completed effects/authority. Old binaries
reject v2. Any downgrade must first use a current reader to reconstruct the latest
committed logical ledger and preserve all later receipts; re-migration requires an
explicitly reviewed backup-preservation plan, not removing the old backup.

Missing, corrupt, symlinked, unsafe or cross-scope dependency snapshots fail load;
ENOENT from a referenced file is not interpreted as an absent/new execution store.
Bounded four-way staging awaits every in-flight writer even on failure. A known
file is re-statted each publication; identity changes force exact-byte/private-file
verification and fsync, and missing files are recreated from the current retained
in-memory snapshot. A stable completed write can skip unchanged disk payloads.
As elsewhere, simultaneous hostile mutation by the same host UID is not excluded
by pathname checks: the owning private directories must not have a competing
writer. Blobs are not automatically retired, including after execution archival.

A manifest-write error may occur after rename. Such an ambiguous error poisons
that owner for further mutations; a fresh owner must reload committed disk state
before continuing. It must never overwrite a possible newer commit from stale
in-memory data. Pre-publication shard failures preserve the old commit and permit
a subsequent queued retry.

The logical expanded storage budget is64MiB, so sharding cannot bypass all host
resource bounds; the small manifest retains its existing32MiB limit. This
does not provide full dirty-execution persistence: mutable task/event data still
clones and serializes on every barrier. Immutable dependencies are deeply frozen
inside the owner, shared safely across drafts, and their exact encoding cached;
caller inputs and public results remain independently cloned. Future dependency
changes must replace a snapshot, never mutate frozen retained evidence. The
clone reconstructs original property order for exact recovery fences.

An initial prototype reduced disk bytes but regressed CPU/RSS; it was not shipped.
With immutable sharing/cache, an isolated actual825-record SSD fixture measured12
warm unchanged barriers: median324→189ms, max event-loop stall214→97ms, peak RSS
755,544→617,656KiB, write bytes404,586,496→73,072,640. First migration1254ms versus
299ms baseline: do not omit the one-time cost. The fixture manifest33,554,414→
5,937,690bytes; all825 logical JSON records and recovery hashes match after a cold
load; exact private v1 backup retained. These are isolated measurements, not
production activation or model-speed proof.

Measure disk bytes and event-loop/checkpoint latency separately from model
inference. Migration is code-delivered through normal exact-head review/CI and
owning deployment; never mutate a live production ledger with maintenance scripts.
