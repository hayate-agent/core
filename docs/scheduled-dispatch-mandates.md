# Host-owned task identity for scheduled occurrences

A new loop, heartbeat, standing-goal, cron or top-level API turn must be able to
delegate within its own mandate. A task ID should not depend on the working model
copying a string out of the prompt.

Before a fresh non-worker turn starts, the host assigns an occurrence identity and
anchor. It is persisted with the inbox before model/tool execution. Separate
occurrences get separate identities even when prompt and conversation are equal.
The host never adopts `session.task`, its expiry, or a prior loop occurrence.
Scheduled tasks are retained separately and do not replace the operator's current
focus pointer. Existing continuation/wait IDs are not replaced. Worker/subagent
sessions remain owned by their exact dispatcher/subagent record.

`plugin_dispatch submit` uses the explicit `submitCurrent` host capability when
`taskId` is omitted. The dispatcher snapshots and verifies the active current
turn's mandate before durable submission. If the model supplies `taskId`, it is
still a strict assertion; mismatch rejects without switching contexts. Missing
host authority rejects. Older hosts lacking this capability do not silently fall
back to unbound submission. Stored mandate ID/deadline remain visible in receipts.

Historical recovery holds remain binding: a held legacy task cannot provide a
current delegation checkpoint, and fresh timer occurrences do not release or
modify old held tasks. Genuine stored continuations retain their exact task ID.
No deadlines are extended; cron report follow-up authority and query-only scope
remain separate from identity assignment.

Regression: Peter native Linux .103's hourly overview was a `/loop` turn in its
Matrix conversation, not a Core cron job. Its 2026-11-11 08:45 UTC transcript
showed a dispatch submit with no taskId, a tool rejection, and no current source
queries. The host previously created DurableTask only for channel ingress, so
recurring turns had no task ID to copy. Tests cover both this loop path and the
actual Scheduler.runJob prompt path, plus heartbeat/goal/API occurrences, distinct
runs, wrong explicit IDs, old held tasks, result routing and absent host authority.
