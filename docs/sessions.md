# Session providers

The Harness selects one authoritative session provider. The bundled filesystem
provider is the default, requires no service or additional installation, and
stores records under Harness home/session-store. The PI adapter uses an in-memory
SessionManager; it does not keep a second writable PI history alongside the
provider. Persisted entries are tagged pi-session-v1: storage is interchangeable,
but history interpretation remains runtime-specific.

```yaml
sessions:
  provider: filesystem
```

Trusted local plugins can call `api.registerSessionProvider(name, factory)` during
activation. The filesystem name is reserved. The async factory receives
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

The PI adapter serializes asynchronous checkpoints from the SDK persistence
callback, waits for a checkpoint at turn completion, title changes, compaction
and disposal, and retries later checkpoints after transient storage failure.
SDK callbacks are synchronous, so a background append alone is not a durable
acknowledgement. The Harness inbox retains unfinished turns for replay; delivery
remains at-least-once, not exactly-once. Failed final checkpoints fail the turn.
Revision conflicts require resolving competing writers, not blind overwrite.

## Existing conversations

On the first opening of a conversation without a provider binding, the adapter
imports its latest existing Harness-owned PI history. It leaves the original
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

## Current scaling limits

The bundled filesystem provider stores an atomic full JSON snapshot per history
and scans records for listing. PI still loads the complete session tree into RAM.
This is an initial backend boundary, not a segmented event store or proof of
arbitrarily large-session performance. Large-history benchmarks, incremental
append/checkpoints, artifact externalization, indexed catalogs and idle eviction
remain required. Alternative providers must not claim to remove the runtime's
memory cost merely by moving records into a database.
