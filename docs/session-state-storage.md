# Per-conversation host state

Conversation work state is stored in `state.json.sessions/<SHA256(session key)>/<SHA256(payload)>.json`, with private immutable revisions. Each payload contains that conversation's task records, recovery/stop/budget/effect metadata, pending inputs, outbox, and subagents owned by that parent. Native model transcripts and the execution/effect ledger remain their existing separately owned stores.

`state.json` is now a small **version 2 publication manifest**, not the combined session payload. It contains global settings/deduplication IDs and exact revision references and ordering. This short shared transaction fence is intentional: accepted ingress, session changes and related deliveries must become authoritative as one complete checkpoint, never a torn mixture after a crash. Up to four session payload writes stage independently. Unchanged payloads are not rewritten. Current-task aliases are stored as references rather than duplicate evidence.

Each capture retains its own durability barrier. Captures are NOT coalesced by assuming that later snapshots supersede earlier stop/inbox/effect obligations. Queued captures keep factories, not full state graphs. The CLI captures synchronous live session views and serializes them before yielding, avoiding duplicate whole-host deep clones. Public snapshots remain isolated. Unchanged encoded payload strings are not retained during I/O. Encoding still visits the live views; this increment does not claim complete dirty-session-only CPU accounting or eliminate the publication fence.

All required session files must be durably staged before atomic manifest publication. Stable missing, malformed, wrong-scope or checksum-invalid committed revisions cause startup to fail closed. They must never be treated as an empty conversation, silently restored from an old checkpoint, or used to replay old effects. Obsolete committed revisions can be retired only after the new manifest is durable. Ordinary transcripts, tasks and effect evidence are not garbage-collected by this mechanism.

## Migration and rollback

The current reader accepts the previous version 1 whole-host JSON. The first v2 publication first preserves its exact original bytes as private `state.json.legacy-v1`. An existing backup must be a same-owner regular 0600 file containing exactly those bytes; any conflict aborts migration before publication. The original v1 checkpoint stays authoritative if staging or publication fails.

**Old binaries do not understand v2. Do not blindly roll back the binary or copy `state.json.legacy-v1` back over the current manifest.** That backup is historical evidence, not current execution authority: later accepted work, completed/uncertain effects, stops, budgets and deadlines may differ. A rollback requires an explicit reviewed forward-compatible reader or a fenced offline conversion of the CURRENT committed shards preserving those semantics. Candidate configuration qualification alone is not a state-format downgrade qualification.

The single host owner/session lock remains required. Private state directories must not be shared between independent host writers. Read-only observers racing a manifest change may retry only if the manifest actually changed; stable corruption is a hard failure.
