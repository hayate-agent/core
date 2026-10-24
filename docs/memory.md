# Memory provider contract v1

Memory is a native Harness capability, not a PI session extension. Plugins can
register `registerMemoryProvider(name, factory)`; `local` is reserved. Factories
receive `{ home, config }` and return `MemoryProvider` from `src/memory.ts`.
Local is bundled, enabled by default, and requires Linux `flock`. No SQLite,
additional database, npm dependency or permanently running LLM is required.

## Configuration

```yaml
memory:
  enabled: true
  provider: local
  autoCapture: true
  autoRecall: true
  scanSeconds: 60
  maxEntries: 10000
  maxIndexBytes: 67108864
  # Optional, explicitly configured embeddings endpoint; no automatic cloud access.
  # embedding:
  #   url: https://embedding.example/v1/embeddings
  #   model: your-embedding-model
  #   tokenEnv: MEMORY_EMBEDDING_TOKEN
  #   dimensions: 768
```

The same partial `memory` object can be configured in persistent
`settings.local.yaml`, overriding installation defaults without modifying a
ConfigMap. Changes require restart. Token values are never stored in Markdown or snapshots.
With no embedding endpoint semantic search is **disabled**, not simulated with
keyword hashing. Full-text token search remains available. Endpoint failure keeps
lexical search available and reports semantic degradation. Configuring an endpoint
consents to sending memory titles/text and search queries to it. Configure only a
trusted endpoint, with appropriate retention and privacy controls.

## Provider obligations

- `put(context, input)`: durable acknowledgement, conversation-scoped idempotency
  key. Same key with a different payload is a conflict. Returns stable ID/revision.
- `get(context, id)`: authoritative current contents, never another conversation.
- `search(context, query, { limit, historical })`: bounded hybrid hits, relevance
  score and review-due marker. Default excludes expired, revoked and archived data.
- `revise(context, id, expectedRevision, patch)`: optimistic concurrency; conflicting
  edits fail. Preserves ID, source and creation time. V1 revises current contents,
  not an immutable revision history (capability `revisions` means revision tokens).
- `forget(context, id, expectedRevision)`: erase source and derived search data.
- `status()`: index availability, entry counts, semantic mode and error state.
- `reindex()`: refresh derived data without erasing source; `close()` drains writes.

The host supplies sessionKey; model arguments cannot select another conversation.
V1 intentionally has no cross-conversation/project/tenant sharing. Handover retains
conversation identity, so memories remain accessible across runtime sessions.
Plugins execute trusted code and are not a security sandbox. Third-party providers
must enforce this contract, not rely on prompt instructions.

## Local storage, worker and recovery

`<home>/memory/entries/<id>.md` is authoritative Markdown with YAML frontmatter.
Metadata includes title, kind, source, verification, timestamps, state, links and
revision. SHA256 of current file bytes is the revision token, so manual edits are
included in optimistic concurrency. Writes are serialized and use fsync + atomic
rename + directory fsync. Markdown deletion is durable before acknowledgement.

A separate Node process maintains `<home>/memory/index.json`, including cached
embeddings keyed by content hash and embedding configuration. Snapshot replacement
is atomic. Startup opens the existing snapshot, then reconciles Markdown in the
background. A corrupt snapshot is rebuilt. Each scan detects manual edits and
removals without relying on RWX filesystem watchers. Invalid files are excluded
and reported; they are never silently deleted. Search rechecks authoritative files
before returning candidates, so a stale snapshot cannot resurrect deleted,
revoked, expired or newly restricted contents. Direct `get` works before indexing.

One worker owns the store through a kernel `flock`, not a PID file or a timeout
lease. No stale-lock stealing. Old/new pods overlapping during rollout cannot both
own it, **provided the storage implements cross-node POSIX locks**. Verify this on
the actual storage class; RWX alone is not proof. A lock conflict leaves memory
unavailable, never permits uncoordinated writes. The Harness retries provider
connection every 30 seconds and restarts an exited local worker. During a lock
handoff, memory can be temporarily unavailable; this is not zero-downtime search.
The existing Harness home ownership mechanism is separate and unchanged.

Each worker accepts at most 64 in-flight requests, requests time out after 30s,
embedding HTTP calls after 10s. Timeout may leave a committed write; retry using
the same key. Background embedding work is limited to 16 entries per scan. The
worker is in the same container/resource envelope as the agent; process isolation
does not provide independent CPU/memory quotas.

The local provider targets bounded personal memory, not an unbounded document
warehouse. Default maximum is 10,000 entries and 64 MiB serialized index. Each
entry is at most 12,000 text characters. Search uses token postings and exact
cosine similarity, not ANN. Source revalidation examines at most 200 ranked
candidates. Memory beyond configured budgets requires deliberate configuration
or an external provider; it is not silently truncated. Snapshot JSON temporarily
requires extra memory when serialized. No linear-scaling claims for large corpora.

## Agent tools, recall and capture

`plugin_memory` supports search/get/put/revise/forget. Preserve concise lessons or
decisions explicitly, including failed approaches. Never store secrets. Writes
are marked **reported**, not magically promoted to verified facts. Links are IDs,
not an automatic graph traversal or permission bypass.

`/memory status|search <query>|show <id>|forget <id> <revision>|reindex` is admin-only.
Automatic recall fetches up to three conversation-scoped memories, bounded to
5,000 characters and framed as untrusted historical data, never authorization.
A read does not renew verification or expiry.

Automatic capture records failed/cancelled replies and completed turns that used
tools, not every casual chat. Records contain a bounded request/reply excerpt,
source key and **reported** outcome, review due after 7 days, expiry after 30 days.
This is a coarse operational checkpoint, not LLM-based significance extraction.
A completed turn is not proof that a merge/deployment succeeded. No extra summary
model is called. Explicit lessons have no automatic expiry unless specified.
Capture first writes a durable file under `<home>/memory-pending/`; background
adoption and periodic ticks retry with the same key after provider failure or
restart. Backlog is bounded to 1,000 files and 32 adoptions per pass. A failure to
persist that initial capture is logged but does not block turn completion, so
this is not an atomic transaction with Harness turn state. An acknowledged
provider write followed by a crash before backlog removal is safely replayed.

Automatic capture can persist sensitive conversation excerpts: disable autoCapture
where this is inappropriate; it is not a secret-detection system.

## Aging and limits

`reviewAfter` marks a verification deadline; it does not mean false. `expiresAt`
excludes an entry from current recall. `revoked` and `archived` also exclude it.
Historical search explicitly retrieves these records. Expiry is evaluated on each
search, including when the snapshot is old. No automatic destructive retention,
no automatic verification, no automatic shared knowledge publication.

`forget` removes the live Markdown and current index vector. Backups, external
provider retention, filesystem snapshots and old native session transcripts are
outside this operation and require their own deletion policy. Manual editors
must not concurrently overwrite a provider write; revision checks detect earlier
edits but do not make external editors participate in the writer lock.
