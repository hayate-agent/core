# Session providers

## Provider ownership and cleanup

The CLI wraps its startup-selected external provider in a lifecycle owner. Each
SDK session holds a lease from open through its final checkpoint and dispose.
Provider operations (including local session listings) are tracked independently.
`SessionProvider.close?()` is optional for compatibility; the host calls it only
after all leases and operations drain, before plugin cleanup. Plugins should not
also close the same instance in an independent cleanup callback.

During owner shutdown, new opens and direct calls are rejected. Existing leased
sessions can still commit their final snapshots. Failed opens release their lease;
repeated disposal/owner close does not repeat backend cleanup. A cleanup failure
is reported, not retried blindly. The lifecycle `retain?()` hook returns an internal
leased view and release callback; ordinary provider implementations need not supply
it. Native PI storage and legacy filesystem imports retain their existing behavior.

This is startup ownership, not runtime provider switching or datastore migration.
Existing session IDs, revisions and checkpoint closures remain on their original
backend. Trusted calls/cleanup can hang: provider draining may extend shutdown
beyond the Harness's bounded transport drain. No forced close or data-loss guarantee
is implied when the process is killed externally.

The native default uses PI's SessionManager and append-only JSONL under Harness
home/sessions. PI owns tree semantics, replay, branches and context compaction.
Harness does not copy the entire native tree on append. The optional filesystem
snapshot provider remains for compatibility and external-provider examples under
home/session-store. External providers use PI's in-memory manager and tagged
pi-session-v1 records: an adapter, not a second conversation engine.

```yaml
sessions:
  provider: native
```

Trusted local plugins can call `api.registerSessionProvider(name, factory)` during
activation. The native and filesystem names are reserved. The async factory receives
`{home, options}` from sessions.options and returns a SessionProvider as declared
in src/sessions.ts. Use api.onStop for connection cleanup. Unknown providers fail
startup. This does not change Harness state.json or cron storage.

A provider implements load, active, bind, create, save and paginated list.
Records have opaque stable IDs, conversation key, title, updated timestamp,
revision, format and entries. save must reject mismatched expectedRevision;
bind must reject sessions from another conversation. create must NOT activate a
record: the adapter binds only after successful initialization. Failed candidate
creation must preserve the previous active binding. Return only durable success.
Use one owner process for a filesystem provider directory; CLI home locking
prevents concurrent local writers. A database implementation must enforce its
revision check atomically. No database provider is bundled in this release.

External providers checkpoint at turn completion, title changes, manual compaction
and disposal. SDK persistence callbacks are not overridden. Mid-turn external
history may replay from the durable inbox after a crash; native PI persistence
continues appending normally. The Harness inbox retains unfinished turns for replay; delivery
remains at-least-once, not exactly-once. Failed final checkpoints fail the turn.
Revision conflicts require resolving competing writers, not blind overwrite.

## Existing conversations

With an explicitly selected external provider, first opening imports the latest
Harness-owned PI history when no binding exists. The native default keeps existing
snapshot bindings on their original provider to avoid returning to stale history. It leaves the original
JSONL files untouched. Older branches/files are not bulk migrated automatically.
Back up Harness home before upgrading. Switching provider configuration is not a
migration: export/import tooling across providers is not yet supplied.

## Names and resume

The local workspace session catalog keeps conversation isolation and ownership.
Sessions with an Untitled catalog name display the provider title derived from
the first user message. `/title` sets the local display title; remote `/title`
sets the provider title. `/sessions` presents titles and activity before IDs;
the local `/resume` picker shows title, activity and a short distinguishing ID.
Explicit `/resume <id>` uses the full identifier from `/sessions`. Local workspace
IDs identify conversation slots; provider IDs identify histories within a slot.
Remote sessions/resume are restricted to the same conversation key. Never infer
identity from a title or use a partial hash as an authority.

## Compaction plugins

compaction.strategy defaults to native and delegates manual /compact and /compress
to PI's existing LLM compaction. Plugins register with
`api.registerCompaction(name, {async compact({instructions, compactNative}) {...}})`
and select their name in compaction.strategy. Await compactNative to reuse the
runtime algorithm; no internal tree is exposed. PI automatic compaction retains
its own settings/hooks. This contract controls manual compaction only, not auto
scheduling. Compaction reduces context, not necessarily archive size or tree RAM.

## Current scaling limits

The bundled filesystem provider stores an atomic full JSON snapshot per history
and scans records for listing. PI still loads the complete session tree into RAM.
This is an initial backend boundary, not a segmented event store or proof of
arbitrarily large-session performance. Large-history benchmarks, incremental
append/checkpoints, artifact externalization, indexed catalogs and idle eviction
remain required. Alternative providers must not claim to remove the runtime's
memory cost merely by moving records into a database.
