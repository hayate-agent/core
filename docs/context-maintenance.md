# Context maintenance

The Harness checks context at serialized working-turn boundaries. PI native overflow
compaction remains a fallback. Maintenance does not call manual compaction while a
working tool is executing. Reviewer calls are not maintenance turns.

```yaml
contextMaintenance:
  enabled: true
  assessPercent: 60
  compactPercent: 75
  checkEveryTurns: 5
  cooldownTurns: 5
  autoHandover: true
```

The same partial object may be stored in `settings.local.yaml`. The core command
`/context-policy status|on|off|handover-on|handover-off` updates that overlay (admin
only). Threshold changes currently use the file and require restart. Unknown context
usage does not trigger automatic compaction. At assessment threshold the agent gets
a lightweight instruction on every configured turn interval, not an extra model call.
Before a queued prompt is passed to the working model, automatic handover runs at
`compactPercent`, or at `assessPercent` if the incoming prompt's estimated token
budget would reach `compactPercent`. The byte-based budget is conservative, not a
semantic classifier for task complexity. The original prompt remains in the durable
inbox and is passed unchanged to the new, seeded session; it is never executed by
the summary operation. A low-usage greeting does not cause a session rotation.
After a completed turn, usage at `compactPercent` triggers native compaction, never
a handover. PI overflow compaction remains a separate emergency fallback.
A persisted cooldown avoids automatic loops and survives process restart, including
failed attempts. Explicit agent checkpoint requests bypass that cooldown.

The bundled `plugin_context_maintenance` tool requests `compact` (after the current
turn) or `handover` (before the next queued turn) with
`preserve` and `resume` text. Requests are persisted and executed after review and the
working turn, not from inside the tool call. Finish the current turn at a coherent
checkpoint. Native summaries retain intent/corrections, decisions, verified results,
Git/PR/deployment state, open work and next steps. Never include secrets. Compaction
may lose details; persistent review state, inbox and authorization are not summaries.

## Completion notices

After a successful maintenance boundary and saved state, Harness queues a short
separate completion notice to the originating reply destination: `♻️ Kontext kompaktiert.` or
`🔄 Neue Sitzung übernommen; Rückschau gespeichert.`. Recovered older handovers
without an archive announce only the session switch. A normally silent `NO_REPLY`
turn still delivers the notice through the normal reply destination/durable outbox.
No-op checks and cooldowns do not announce success. Failures report that maintenance
has not fully completed, without exposing model/runtime exception details or claiming
that the original session is necessarily still active. A pre-prompt recovery reports
its completion at the next boundary. The completion record and pending notice (stable
ID, conversation key, destination, text) are persisted together. Startup and periodic
ticks adopt pending notices into the durable outbox; acknowledgement happens only
after the outbox persistence barrier succeeds. A crash before acknowledgement retries
the same ID. Existing restored outbox entries are reused, not enqueued twice. Channels
without delivery-ID deduplication can still display duplicates after a send/crash;
this is at-least-once delivery, not a cross-system exactly-once transaction. A crash
after a runtime side effect but before its completion record is saved remains a
separate runtime-recovery limitation. Local-only turns without a destination retain
the inline notice behavior. Builds/merges do not activate this behavior in already
running instances.

## Handover archives and retrospective access

Each handover now captures the original active branch's text entries **before** native
compaction. It stores a backward-looking retrospective and a forward checkpoint in
`<home>/session-archives/<conversation-hash>/<archive-id>.json`. The archive records
source session ID, target ID after switching, entry IDs and timestamps for the archive.
The forward seed includes the current/next-steps section and the latest three operator
messages (bounded), plus the archive ID. Native compaction generates the retrospective
without a separate autonomous agent turn; model compliance with section instructions
is not guaranteed, so the checkpoint uses a bounded fallback when the label is absent.

`plugin_session_history` reads `section: summary` or paginates/searches original text
entries by archive ID, `query`, `offset`, `limit` and `charOffset`. Access is scoped to
the current Harness conversation key; archive IDs cannot address another conversation
or arbitrary files. Reads are bounded. The seed explicitly asks the new agent to read
the retrospective before continuing. This is model guidance, not a guaranteed read
acknowledgement; short forward state is already in the seed. Summary responses are
bounded to 20,000 characters; full text remains on disk. Images and non-text blocks
are not duplicated into the text archive; the native session remains the original.

Historical instructions are context, not new authorization. Archives may contain
sensitive task data just like session history; protect Harness home. No automatic
archive retention/deletion is implemented yet. A failed refreshed handover can leave
an unreferenced archive; it is retained rather than deleting possible recovery data.

## Handover

Explicit tool requests can hand over even when automatic handover is disabled.
Automatic handover is opt-in; at >=90% usage it replaces compaction when cooldown
permits. Native compaction produces the tool-free handover summary (and also compacts
the old session); no extra working-model turn is used to generate it. The summary is
saved as a prepared transition before a fresh runtime session is opened. The new
session is seeded without executing tools. The next queued operator request reads
that seed as context and continues; no artificial autonomous continuation is enqueued
when there is no work. Channel, thread, queue, goals and review budgets remain owned
by the same Harness session key. Old native session history remains on disk.

A failed rotation retains the prepared summary. If the old session processes another
turn before retry, the summary is refreshed before rotation. If restart resumes a new
session before the switched marker was saved, the saved handover is seeded again;
this can duplicate context but does not intentionally repeat tool actions. This is
recovery-oriented, not an exactly-once model/side-effect guarantee.

Limitations: there is no automatic archival/pruning of native conversation history;
no isolated summary model; no automatic continuation without queued input; and no
UI notification for every maintenance operation yet. The service stores one small
state/checkpoint file per Harness session in `<home>/context-maintenance/`. Rotation
uses the existing session-provider binding contract; custom providers must honor it.
A summary error leaves the current session available and reserves cooldown. A failed
prepared-recovery attempt fails that boundary rather than silently discarding context.
