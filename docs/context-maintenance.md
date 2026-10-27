# Context maintenance

## Strategy ownership and startup selection

The bundled semantic boundary assessor and pure tool-result projection algorithm
are maintained in `harness/plugins`, pinned with immutable revision and hashes.
Core keeps the boundary state machine, persistence, usage observations, cooldowns,
authority checks, provider rotation and compatibility configuration validation.
No state/checkpoint format or default behavior changes in this extraction.

`contextStrategy: plugins/my-context.mjs` selects trusted local startup strategies.
The ESM default export is `{apiVersion:1, create({backend, model})}` and returns
`{assess, project}`. `assess(evidence)` is advisory and returns compact/handover/keep/
unknown; host boundaries still decide eligibility. `project(messages, policy)` is
a synchronous pure per-request projection, never a transcript rewrite. Preserve
call IDs, errors, nontext content and live result correlation. Return the original
array when unchanged. Class methods retain their receiver. Create only prepares;
strategies must not start receivers or unmanaged background resources.

Unknown/malformed modules fail startup, not silent fallback. This is trusted
in-process code, not a sandbox; custom projectors can inspect context and must
honor the runtime contract. The stock PI adapter no longer imports a concrete pruning
algorithm: the CLI supplies the selected projector. Other hosts embedding PiRuntime
must explicitly provide projectToolResults to enable projection. A missing projector
leaves request messages unchanged. Build/merge is not activation evidence.

### Local advisory/projection lifecycle

The administrative `/context-strategy` plugin supports `status`, `use <module>`,
`disable`, `baseline` and `reload`. Paths are trusted executable modules relative
to Harness home; command paths cannot contain whitespace. The async factory is
fully prepared and both receiver-bound methods validated before settings persist;
the pair becomes visible atomically only after successful save. Busy owners,
maintenance operations, invalid modules or save failures retain the current pair.
The plugin reserves Harness idle first, then the maintenance service. Direct
embedded maintenance operations also prevent a switch; during replacement new
maintenance/status operations reject with a retryable error rather than waiting.

`settings.local.yaml` stores `contextStrategy`: path replaces, null disables,
absence restores the captured installation baseline. Disable supplies unknown
advisory assessment and identity projection. It does not disable explicit manual
maintenance, host pressure policy, native overflow compaction or change provider,
compaction implementation, task grants or pending handover state. The runtime
callback reads the current pair at each request; an assessment captures its method
once and cannot be replaced while its maintenance operation is active.

Baseline restoration uses the prepared startup instance. Reload cache-busts the
selected entry module only; transitive imports retain Node ESM cache behavior,
and generations remain until process exit. Async create must only prepare pure
behavior; side effects of trusted imports/factories are not rolled back on failure.
This is not provider migration or a live replacement of compaction objects already
captured by existing runtime sessions. Existing startup default behavior is retained.

### Registered compaction wrapper selection

The administrative `/compaction-strategy` plugin supports `status`,
`use <registered-name>` and `baseline`. It selects only already registered trusted
wrappers, not module paths or downloadable code. The installation baseline is
`compaction.strategy` (default `native`); `settings.local.yaml` may persist a
`compactionStrategy` name. Removing the override restores the installation baseline
on restart. Missing names fail startup rather than silently selecting native.

A stable forwarding adapter lets already-open CLI-owned sessions use the selected
wrapper on their next explicit compaction. Each operation captures one strategy;
a running compact, working turn or maintenance operation blocks selection changes.
Validation and durable save precede publication. Unknown names, busy boundaries
or save failures retain the previous selection. Embedded sessions explicitly given
a fixed strategy retain that behavior; no provider replacement is performed.

`use native` removes an optional wrapper and performs real native compaction.
There is deliberately no no-op `disable` that could falsely acknowledge applied
maintenance. Automatic-maintenance policy is separate. Timeout, abort, checkpoint
after success, native overflow compaction and native handover summaries are unchanged.
Plugin registration/removal and code reload are not supplied by this command.
Source merge/build does not activate a running installation.

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
usage never becomes an invented percentage. It persists as `observation.usage=unknown`,
suspends automatic threshold actions and produces one durable informational notice
per unknown-usage episode (not a completion notice). Fresh known usage rearms that
notice. PI intentionally reports unknown immediately after compaction until a fresh
successful assistant response supplies usage. `beforeObservation` retains the latest
pre-turn decision independently of the post-turn observation.

At assessment threshold the working agent gets a lightweight reminder on every
configured turn interval. Eligible automatic boundaries additionally use a bounded,
tool-free semantic assessment through the configured review model: recent branch
text is evidence, and incoming work is classified as checkpoint-resumable/new work
versus tightly coupled continuation, never as fresh authority. No incoming byte-to-token
percentage is fabricated. Malformed/unavailable assessments defer the operation.
Before a queued prompt, handover may run at `assessPercent` when the assessment
selects handover. After a useful work boundary, usage at `compactPercent` may select
compaction **even when autoHandover is enabled**. The original prompt remains in the
durable inbox and is passed unchanged to the seeded session, not executed by the
assessment or summary. A low-usage greeting without prior pressure causes no rotation.

Separate persisted compact/handover cooldowns survive restart and failed attempts.
A successful compaction retains `pressureSinceCompaction` until a safe pre-turn
handover or session replacement: relieving pressure must not erase eligibility for
a later semantically appropriate handover. Compaction therefore cannot continually
consume the handover cooldown or starve it by lowering usage. Unknown usage still
defers automatic action, including this remembered pressure. Explicit checkpoint
requests bypass cooldown and semantic assessment.

PI overflow compaction is independent and can bypass Harness completion notices.
A native JSONL `type=compaction` entry is evidence of a real compaction; absence of a
Harness notice does not prove no compaction occurred. This service does not yet
persist or announce every SDK-native compaction event.

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
valid JSON with at most 1,500 characters per retrospective/forward field. Use
`charOffset` to page both fields; `retrospectiveTotalChars`, `forwardTotalChars` and
the corresponding `*Truncated` flags report remaining content. JSON escaping may
increase the serialized size; full text remains on disk. Images and non-text blocks
are not duplicated into the text archive; the native session remains the original.

Historical instructions are context, not new authorization. Archives may contain
sensitive task data just like session history; protect Harness home. No automatic
archive retention/deletion is implemented yet. A failed refreshed handover can leave
an unreferenced archive; it is retained rather than deleting possible recovery data.

## Maintenance cancellation and deadline

Native compaction and handover summarization have a five-minute host deadline.
At the deadline the Harness aborts the SDK compaction controller and reports
failure, retaining the original session/prepared checkpoint rather than claiming
a successful handover. `/stop` also aborts pre-turn maintenance even when no
working prompt has started. This does not reset a review escalation or grant new
authorization. A backend ignoring cancellation may still finish its remote
request; cancellation is not a rollback of server-side computation.

## Manual handover command

`/handover [resume instructions]` immediately requests and performs a durable
fresh-session handover for the current idle conversation. It summarizes and
archives the old session, seeds the replacement and returns a completion/failure
notice; it does not start a working model turn or invent permission to continue.
The default resume instruction is to wait for the next operator request. Manual
requests work even when automatic context maintenance is disabled. Normal command
administrator authorization applies. Busy conversations, queued work and pending
outbox delivery are refused; finish or stop that work and retry. A runtime without
summary/seeding support reports failure rather than claiming a switch. Prepared
handover recovery uses the existing crash-safe transition. `/compact` remains
in-session compaction and is not a synonym for `/handover`.

## Handover

Explicit tool requests can hand over even when automatic handover is disabled.
Automatic handover is controlled by `autoHandover` (default true) and coexists
with post-turn compaction under the semantic boundary policy described above. Native compaction produces the tool-free handover summary (and also compacts
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
