# Optional durable dispatcher

## Routing and recovery guarantees

With an enabled, ready dispatcher, Main orchestrates; shell execution and file
mutation (`bash`, `write`, `edit`) run in dispatcher workers. A runtime tool guard
enforces this even after worker failure. Native read/search and dispatcher status
remain available to Main. Starting a separate subagent is not a way around this
routing rule. Main fallback is available only when dispatcher mode is disabled or
the dispatcher is unavailable.

Both `worker-failed` (for example a provider EOF) and the broader
`runtime-failure` strategy/validator interruption have a durable automatic
recovery owner. An internal `paused` or `blocked` state is not a terminal
lifecycle state: its stored `workerRetry.nextAt` is consumed by the existing
scheduler, including after host restart and for diagnosed legacy internal pauses.
Cheap ticks never renew that due time.

The parent supervisor also distinguishes **no decision** from an independent
`blocked` verdict. A review skipped or invalidated by newer input, interrupted,
unavailable or inconclusive retains the open mandate and a persisted read-only
assessment retry (one minute, exponentially backed off up to one hour). No model
proposal becomes an execution permit. New input cannot strand older work merely
by displacing its review; the host records queued/interrupted deferrals. Restart
retains the same retry owner. A fresh independent verdict replaces the old
non-decision, including a genuine denial. Proven historical false blocks with
`supervisorDecision.verdict: unresolved` are re-enrolled for assessment only;
held-legacy tasks, stopped/completed tasks, terminated/exhausted work and expired
mandates are not reactivated. Worker intents and effects are never replayed by
this repair, and existing approval/dependency gates remain binding.

A sequential correction retains its settled assessment until the recovery handover
is durably saved. If a legacy recovery session contains only metadata, the host
may transfer the same execution's bounded correction/assessment checkpoint instead
of a transcript. That packet explicitly marks prior effects as unknown: it is
not a retry grant or evidence of success. The original worker must reconcile
actual effects before any uncertain external action. Bare intents without a
retained correction or assessment still fail closed on empty transcript evidence. Explicit user pause (`manual-pause`),
cancellation, deadline expiry and unanswered questions are different holds and
are never auto-resumed.

A typed `worker-failed` outcome is a technical interruption, not a semantic blocker. The scheduler requeues the **same execution
ID** with durable exponential backoff (15 seconds up to 5 minutes), retaining its
intent, original mandate and worker transcript. The matching strategy must support
reconciliation; no opaque effect is blindly replayed. Manual pauses, cancellation,
unanswered questions, authentic mandate expiry and trusted recovery-policy holds
remain binding. Technical retries have no total-attempt cutoff. Generic strategy exceptions are classified as `runtime-failure`, without
inferring permission or diagnosis from exception text. With a reconciliation-capable
strategy, they receive the same durable backoff. A retained sequential assessment
is rechecked independently before any new worker effects; a genuine blocked verdict
does not start a successor or repeat settled effects. A reviewer-confirmed completed
step overrides the worker's own `blocked` label without an extra parent decision.
Real policy holds take ownership back and clear automatic retry metadata. Scheduled
pauses are projected as timed automatic recovery, not repeated requests for human
intervention.

Sequential execution yields capacity at committed step boundaries when another
execution is ready. Round-robin admission lets a queued review run before the
publisher claims its next step, including with capacity 1. An in-flight worker is
not preempted and its work is never duplicated to free a slot.

A model-selected wait deadline bounds polling, **not** the operator mandate.
Only the task's authentic `expiresAt` limits task authority. While a child is
running, a parent wait retains its read-only monitor even when the validator
proposes productive continuation. The host renews that nonproductive polling
window as necessary, without extending any authentic task expiry. Parent monitors
cannot mutate or control the child. Once the child settles, the original task is
independently assessed for the next deliverable. Historical task expiries are not
automatically cleared: their original provenance must be reconciled separately.

The dispatcher is a host scheduler, not another model loop. Main submits a scoped
operator task and receives a durable result event. A trusted strategy owns its
execution; Main does not have to create or poll workers. Ordinary operator turns
remain available while background tasks execute, subject to backend capacity.

This feature does not add task decomposition, a workflow board or new authority.
Without dispatcher mode, Main continues using ordinary turns and optional
[managed subagents](subagents.md). The common execution ledger is loaded in both modes. Ordinary Main turns,
managed-subagent turns and dispatcher worker turns all record a stable turn
identity and terminal settlement there; dispatcher tasks additionally use its
claim/effect/event records. Main is not redirected through a background worker.

## First-time activation

The [starter profile](examples/hayate-agent.yaml) keeps dispatch disabled.
For a minimal first activation, see the
[direct/sequential setup walkthrough](gateways.md#4-optional-background-delegation-enable-the-dispatcher).
Use `direct` with the default `capacity: 4` (or an explicit lower backend limit)
after confirming backend concurrency, then restart
and check `/dispatch status`. `sequential` additionally needs real registered
model-role selections; model IDs, context capacities and supported reasoning
levels are not prescribed by the starter. Ordinary terminal/WebUI/Matrix chat
works without enabling dispatch.

## Configuration

The same `dispatcher` mapping may be set in writable
`<home>/settings.local.yaml`. It overrides installation fields individually and
is validated against the merged policy. Enable/strategy/capacity changes require
a controlled process restart; changing the overlay alone does not activate a
scheduler in the existing process. No modification of root-owned `hayate-agent.yaml`
is necessary.

```yaml
dispatcher:
  enabled: true
  strategy: direct
  concurrentRequests: true
  capacity: 2
  retentionDays: 7
```

Defaults are `enabled: false`, `strategy: direct`, `concurrentRequests: false`,
`capacity: 4`, `retentionDays: 7` (integer, 1–3650). Enabling requires the operator's explicit declaration that the
configured runtime/backend supports concurrent requests. This declaration does
not probe or configure the backend. Capacity limits active strategy executions,
not the number of retained tasks or configured persistent workers. The runtime
must also have headroom for Main, approvals and review requests.

Capacity is the **worker execution limit**, not a dispatcher execution slot.
The scheduler accepts multiple durable tasks, fills available worker capacity and
handles independent completions while other tasks are still running. It does not
wait for an unrelated publisher before starting an independent review if worker
capacity is available. A genuinely dependent review must still wait for its input.
Pending tasks are bounded by the ledger's storage limits, not by worker capacity.

Main answers short questions, known facts and simple status requests directly and
uses its available tools for bounded lookups, local inspection and short research.
Enabling the dispatcher does not make delegation mandatory or remove Main's tools.
Delegate substantial, long-running or independently parallel work when useful;
keep existing authority, tool allowlists and review requirements intact. Current
worker capacity, active executions and runnable queue length are supplied as host
facts on each turn; do not infer that the dispatcher itself is busy or single-slot.

The default applies to **every installation** that leaves capacity unspecified.
Explicit installation, settings and drop-in values (including `capacity: 1`) remain
binding; upgrading Core does not silently override a backend/operator limit. Audit
those layers fleet-wide when rolling out, choose a backend-supported worker limit,
and restart each process to activate it. Existing persona instructions that demand
delegation of all work should be narrowed to substantial tasks, not short questions
and bounded information requests. No automatic live rollout is performed.

`direct` is the reserved built-in strategy: one ordinary isolated Harness turn
per task. It uses the configured runtime rather than calling PI directly. It
cannot spawn nested subagents, schedule loops, submit further dispatcher work or
authorize continuations. Approvals route to the trusted parent conversation.
Plugins can supply other execution strategies; they are trusted process code,
not sandboxed workers. Main cannot select replay policy in a tool call.

Direct routing classification is tool-free and is not the delegated worker. If its
HTTP outcome is interrupted or unknown, the host durably marks the receipt
`abandoned` and uses the existing configured default worker model. It does not
repeat the unknown classifier HTTP call. Startup and automatic recovery also
adopt pre-existing classifier-only pauses, retaining the execution identity and
receipt, provided the matching direct strategy supports reconciliation and no
worker effect intent or settled effect exists. Manual pauses, cancellation,
expired mandates, stopped parents and actual recovery policies remain enforced;
productive worker effects are never made replay-safe by this fallback. This
change does not apply to sequential planning or independent validation.

The new receipt phase requires this Core version to read the ledger. Before
rolling back to an older version, stop the runtime and use a reviewed compatible
ledger migration or restore the pre-upgrade snapshot; do not discard receipts.

`sequential` is an opt-in reserved built-in plan-and-execute strategy on the same
scheduler, ledger and worker bridge. It requires enabled [model roles](model-roles.md):

1. One tool-free ephemeral planner turn on the exact `dispatcher` role returns a
   closed JSON plan of 1–6 steps, each with the lowest sufficient capability role
   (`simple`/`medium`/`high`), a reason and the evidence it must prove. A single
   simple step is valid. Roles follow reasoning and task complexity: `simple` for
   factual answers, read-only inspection, deterministic mechanical edits and known
   runbook execution; `medium` for bounded implementation or fixes in known code
   with their tests; `high` for genuinely complex reasoning beyond medium, such as
   ambiguous root-cause investigation, difficult concurrency/recovery reasoning or
   architecture. Operational risk is independent of model capacity: production,
   credentials, deployments or irreversible effects alone do not require `high`.
   Routine authorized credential rotation with a known runbook and production
   read-only checks can be `simple`. Existing authorization, safety and verification
   gates still apply at every role; routing grants no permission or gate bypass.
   One coherent change with its tests is one step. This is a model judgement, not a
   guarantee. Malformed output is a visible block, never repaired.
   When the runtime offers the HTTP planner capability (PI runtime), planning is
   one tool-free SDK request through the existing authenticated assessment
   transport (no retries, no redirects, exactly one send) with the same prompt,
   system prompt and strict plan validation. If the exact `dispatcher` role cannot
   be served over HTTP (unsupported API, thinking level or missing auth), planning
   blocks visibly; there is no session, default-model or complexity fallback.
   Runtimes without the capability keep the ephemeral session planner.
   A worker's `STEP-STATUS: complete` is only evidence: the host independently
   checks the step and required evidence on the exact `reviewer` role before
   persisting completion or admitting a successor. Missing/empty/malformed worker
   reports are assessed too, never silently accepted or excluded from validation.
   A step-specific tool-free reviewer requests concrete read-only evidence or a
   missing final report from the same retained worker (at most two corrections).
   Failed/inconclusive inference is attempted at most twice per worker result,
   without re-running the worker, replanning or upgrading its model. Genuine
   external holds still stop immediately; exhausted inference pauses visibly.
2. Plan, step index and outcomes are persisted in the execution checkpoint before
   any worker turn; each step saves an unsafe intent with its exact route first.
3. Steps run sequentially as ordinary worker turns in the task-bound session with
   the original task as authority. Deadline, parent stop and ownership are checked
   before every step; approvals keep trusted parent routing. Prior outcomes are
   passed as untrusted data.
4. A step counts only with a final `STEP-STATUS: complete` line AND independent
   completion. A missing line can be repaired by a bounded report-only correction,
   never by silently inferring success. A genuinely held step does not automatically
   hold every later deliverable: the selected independent validator may admit one
   exact existing later step only when it is authorized and independent of the hold.
   Required ordering, approvals, CI and unknown-effect reconciliation remain binding.
   The same execution retains the blocked step's report, correction budget, original
   route/session and stable intent identity, persists the reordered suffix, and runs
   only the admitted work. The held step stays open and is reassessed without replay;
   the overall task cannot complete while it remains held. A new parent clarification
   invalidates an unstarted readiness permit. No verdict, malformed selection or
   insufficient checkpoint space leaves the hold intact. This does not create a
   second writer or invent a replacement plan. Existing current plans with a durable
   settled assessment adopt this scheduling policy once at normal recovery: stale
   assessment-only backoff becomes due for fresh independent evaluation, with the
   attempt/correction budget, report, route and uncertain intent preserved. The
   atomic policy marker prevents repeated wakeups on subsequent restarts. Manual
   pauses, questions, stopped/expired/disabled and held-legacy work are not enrolled;
   an opaque intent without a matching settled assessment is not eligible.
   Progress delivery failures do not fail
   the persisted plan. The final result lists requested and
   observed model per step and is produced only when every step completed.
   `STEP-STATUS` is only the worker's step outcome signal inside the strategy; the
   aggregated result is delivered to the parent as untrusted host data and still
   passes the parent's independent completion/admission validation.
5. Roles are used exactly: an unconfigured or unavailable role blocks visibly
   instead of silently using the default model. Technical planner failures never
   switch models. A step reporting `STEP-STATUS: inadequate` without any tool call
   is retried once one role higher; otherwise the limit is reported.
6. Restart resumes from the persisted plan without replanning. An unresolved step
   intent uses the existing transcript reconciliation; without retained evidence
   it blocks for explicit operator resolution. A persisted settled worker result
   is revalidated without replaying its tools. Evidence and inference attempts
   survive restart; restarting/resuming does not reset the inference budget. A
   correction after restart reconciles the retained session before any worker
   turn. Evidence excerpts may be truncated to the checkpoint budget. Effects
   are never replayed blindly. Recovery transfers a bounded evidence projection
   (at most 48 KiB of serialized UTF-8 JSON), not the entire recursively nested
   transcript. Older handovers become original-session references. Omitted or
   truncated entries are explicitly marked; missing evidence never proves that an
   external effect did not occur. Original transcripts and execution checkpoints
   remain intact for read-only reconciliation. The runtime rejects handover seeds
   above 64 KiB before modifying the SDK session, avoiding a partially created
   first session file followed by an endless EEXIST retry loop.

Not yet included: parallel steps, replanning after failure, per-step operator
approval of the plan, and plugin-visible plan inspection beyond `/dispatch` status.

With an explicit nonempty model-tool allowlist, dispatcher mode adds
`plugin_dispatch`. An empty allowlist still exposes no model tools.

## Submission and control

`plugin_dispatch` accepts:

```json
{"action":"submit","requestId":"stable-request-1","task":"The authorized task and its constraints"}
```

It returns after durable acceptance and scheduling, not after completion. Task
inputs are validated at submission: nonempty strings up to 1 MiB; larger
submissions fail closed. Reuse
`requestId` only for an identical retry in the same parent conversation. A
conflicting task with that ID is rejected. `status` lists this conversation's
records; `pause`, `resume` and `cancel` require an `id`. Models in managed children
and dispatcher workers cannot use this tool.

Operator commands are mechanical and require no model call:

- `/dispatch status`
- `/dispatch compact` — archive eligible terminal records in this conversation now
- `/dispatch pause <id>`
- `/dispatch resume <id>`
- `/dispatch cancel <id>`
- `/dispatch answer <id> <questionId> <text>` — answer a pending strategy question

Pause/cancel revoke the claim before signalling the worker. A slot remains occupied
until execution settles; a slow cancellation does not create extra capacity.
Pausing with an unresolved effect blocks the task rather than permitting unsafe
resume. Cancel does not undo external effects. Completed/cancelled records remain
inspectable. `/stop` on a parent durably cancels its nonterminal dispatcher tasks
and revokes delivery of all their results, including results already queued for
Main. A new submission with a new request ID is separate work.

## Bounded steering and durable decision consolidation

The active parent decision window remains bounded (32 records / 16 KB), but it is
not a lifetime correction budget. When it fills, the authenticated parent uses
`plugin_dispatch_decisions status`, then `consolidate` with the exact applied
`replaces` request IDs and a complete current scoped working context. Preserve
all original operator restrictions, applicable approvals/CI, remaining work and
unknown-effect reconciliation. This explicitly amends parent working directions;
it never grants authority, marks work completed or silently removes constraints.
Pending decisions cannot be consolidated away. If a prior restriction is unclear,
read its exact archived receipt instead of inferring permission.

Original records are durably archived before the atomic active-window commit;
`read` retrieves their exact text and receipts by request ID. Their idempotency
and conflicting-ID protection survive reload and repeated consolidation. A
failed save retains the old active window; retry verifies the same archived
originals. Revisions are monotonic across consolidations, independent of active
window length, so stale assessments remain fenced even after more than 32
lifetime decisions. Consolidation cannot steal a running claim, clear an unsafe
intent, reset budgets, bypass a question/manual pause/stop, or create a second
writer. The existing strategy still owns safe reassessment admission.

If the parent amendment introduces still-authorized work absent from the remaining
saved steps (for example fixing compatibility after a source publication milestone),
`consolidate` may include a typed `followUp` task, role, reason and required evidence.
The sequential strategy attaches that exact receipt once at the retained assessment
boundary. It preserves the existing open step and all completed outcomes, and uses
the same independent readiness admission before moving to the follow-up. That
admission is checked even when the old step's validator asks for more same-step
corrections: a local `continue` must not indefinitely starve an explicit independent
parent follow-up. Before switching, the host atomically settles the old worker's
intent with its preserved assessment and selected order. A rejected readiness
assessment never permits follow-up effects. Readiness evaluates the first safe
in-scope action, not whether the candidate has already produced its deliverable;
a failed test assigned to be repaired is open work, not itself a prohibition on
starting the repair. Prior effects are reconciled read-only first. Readiness tool
and completed-result evidence is supplied through the existing budget collector,
so an oversized evidence block can be explicitly projected without shortening
authority, parent instructions or candidate identity. Missing projected evidence
never establishes absence of effects. New work
never marks the old hold completed or replays its worker. Stable original intent
IDs, checkpoint size and the six-step **active window** remain enforced, not a
six-step lifetime limit. Before an amendment runs out of slots (or completed
results consume checkpoint space), the host writes the exact independently
completed prefix to `execution-plan-audit/<execution-scope>/<sha256>.json`, then
atomically commits a linked history pointer and the remaining active window.
Archive-before-pointer interruptions retry idempotently; parent revisions, stops,
claim ownership and expiry fence admission. Original task authority, held reports,
route/session, correction/progress budgets and unsafe intents are preserved.
Stable new step identities increase monotonically; retiring a slot never reuses
an old effect identity. The bounded recent amendment-ID cache is supplemented by
a monotonic revision watermark, so old amendments cannot reattach after eviction.

`plugin_dispatch_plan_history` provides exact bounded/paginated read-only history
for the owning parent or its current same-execution worker, including after normal
terminal-ledger compaction. History is untrusted evidence, never new authority or
proof that unfinished work completed. Review packets explicitly flag omitted
archived evidence as incomplete. Final receipts count and reference earlier
completed steps rather than silently omitting their existence. Missing/corrupted
history fails closed. A fully unfinished window keeps extra directives queued;
`plugin_dispatch_decisions status` distinguishes recorded directives from actual
plan admission and exposes active/completed/history counts and queue causes.
Unsupported, out-of-scope or dependent follow-ups receive no execution admission.

## Persistence and restart

`executions.json` under Harness home holds tasks, claims, checkpoints, effect
intents, outgoing events and common Harness turn settlements. A settled turn
stores its reply outbox, continuation decision, goal state and consumed steering
inputs before the separate inbox/outbox completion snapshot. If the process dies
between those commits, ordinary inbox recovery transfers the saved settlement
without another model call. A turn still marked running retains ordinary
at-least-once recovery; the ledger does not declare opaque Main effects safe.
Old inbox entries acquire a turn identity before starting. Settled common turns are pruned only after the inbox/outbox completion snapshot
is durable. Startup reclaims settlements left behind after that checkpoint,
while preserving pending inbox entries and worker settlements needed by unresolved
dispatcher intents. Delivered terminal dispatcher records are archived after `retentionDays` (hourly
host maintenance, including with dispatcher mode disabled). `/dispatch compact`
archives this conversation's eligible terminal records immediately. Pending host
results, undelivered events and unresolved effects prevent archiving. Legacy
records without timestamps receive a fresh retention window.

Archives live in `executions.json.archive/`, one atomically written record per
hashed parent/request identity. Archive creation is durable **before** active
removal; a crash between the writes leaves a harmless duplicate. A retry checks
the archive and returns the original completed/cancelled record; a conflicting
request is rejected. No replay is authorized by archive eviction. Archive writes
that fail leave active records intact.

Archives are not automatically deleted. They retain the full result for retry
inspection and must reside on persistent storage. Thus active ledger growth is
bounded, but historical disk usage is not: monitor disk space and back up archives.
Deleting archives removes deduplication receipts and is not a safe cleanup method;
a future archive-generation/expired-ID contract is needed for finite historical
retention. Limits are 2,000 retained dispatcher tasks, 10,000
unacknowledged common turns and a 32 MiB serialized ledger. Reaching a limit
rejects new writes/work rather than deleting active or ambiguous records. Use `/dispatch compact` to reclaim acknowledged terminal records after active
record exhaustion; blocked/ambiguous work requires reconciliation. These are single-home limits, not distributed quotas. It is owned by one Harness process under the home
lock. Writes are serialized and atomically replaced with durable filesystem
operations. Keep Harness home on persistent storage; this is not a multi-process
or distributed database.

Task completion and its result event share one ledger commit. Results enter the
ordinary durable inbox with stable event IDs, then the ledger acknowledges them.
Inbox deduplication handles redelivery. Host results are data, not slash commands,
operator requests or continuation grants. They queue behind a busy turn instead
of steering or interrupting it. Their authority is checked again before execution,
after asynchronous setup, at runtime execution and at tool boundaries. They do
not overwrite the parent's task checkpoint or conversation destination.

Before a built-in worker's first opaque intent is recorded, metadata-only
preparation durably creates a native/provider history containing its exact
execution/session identity and original-task hash. No model, tools or MCP start
for this barrier, and it is explicitly NOT an effect result or completion. A
preparation failure leaves no unsafe intent, so corrected runtime startup can
retry normally rather than stranding an unstarted worker as an unknown effect.

For older direct executions whose replacement history was already lost, the
immutable `turn:<execution>:<original-token>` intent identifies the exact original
worker. If its history still exists, recovery may read those known prior facts
without editing the ledger or selecting a guessed session. Missing intermediate
history is explicitly UNKNOWN: inspect actual effects, never replay completed
results. If both histories are absent, the hold remains; this is not permission
for a fresh worker or a historical bulk-unpause.

On restart, old worker evidence is read through the runtime's read-only
`retainedSessionHistory` interface when no source session is already open. Reading
history must not reopen the old model, MCP processes, extensions or tools. A
missing persisted source is an explicit hold, never a newly created empty source;
incomplete history remains unknown evidence. Only the replacement working
session is opened after the retained evidence has been read.

Recovery handover durability is a prerequisite for publishing a replacement
worker session: native PI custom-message-only histories must be crash-durably
published even before their first user/assistant prompt. The host writes the
exact public SDK snapshot with exclusive publication, fsyncs it, and synchronizes
PI through its public `setSessionFile` API. It never fakes conversation messages,
mutates SDK-private flags, or overwrites a conflicting/partial file. External
providers retain their awaited checkpoint barrier. A second restart during
recovery must find that exact history, not silently start an empty session.

Successive seed-only recoveries flatten bounded prior receipt text and preserve
source references instead of dropping every prior result or recursively quoting
old JSON. Original session files remain authoritative; omitted evidence and
unanswered tool outcomes stay explicitly uncertain. This does not grant effect
replay, alter the original task/expiry or unblock real operator holds.

The built-in direct strategy saves an **unsafe intent before an opaque runtime
turn**. An interrupted turn with unknown external effects becomes `blocked`;
startup never independently replays its old Harness inbox or continuation. A
settled turn retains its result before the final completion commit, so a restart
in that gap returns the saved result without another worker turn. Unknown
strategies, changed versions and repeated interruptions also block automatic
recovery. For a blocked `resume`, the parent uses `plugin_dispatch_recovery`
`action: evidence` with the exact execution ID. `field: execution` returns the
retained ledger record; `field: transcript` pages the exact host-bound worker
entries (`entry`, `charOffset`, maximum 8000 characters per page). This never
opens a model session, runs a worker or edits its transcript. Evidence is scoped
to the original parent and remains untrusted data, not new authority.

After inspecting the transcript and reconciling actual external effects, use
`action: continue`, the returned `fingerprint`, a stable `requestId`, and bounded
`evidence` describing the actual-state reconciliation. The same execution retains
its intent, checkpoint, worker history and counters. Only a matching strategy
with reconciliation support may continue; the existing runtime imports that
history before remaining work. There is no arbitrary retry grant, alternate
publisher, completion override, or recovery-policy bypass. Host policy, manual
pause, parent stop, expiry, ownership holds, held-legacy enrollment, unanswered
questions, missing/incomplete/compacted transcript evidence and unmatched tool
calls remain fenced. A tool response is not proof that its effect did not occur:
reconcile actual state before continuing. Concurrent state changes invalidate the
fingerprint; identical request retries return their original receipt without
starting another worker. An ordinary `continue` never clears a manual pause.
When the current operator mandate explicitly authorizes resuming that paused
writer, the parent uses `action: resume-paused` with the same evidence and
fingerprint gates. This is explicit pause/resume control, NOT an automatic
recovery permission or effect retry. The receipt audits the resumed pause. Every
pause/resume/cancel increments the execution control revision: even a repeated
identical pause invalidates earlier fingerprints. Parent/operator stops, expiry,
questions, unknown effects and host policy cannot be bypassed this way.
Do not make a replacement submission to bypass this
boundary, and never edit live ledger files.

This is not exactly-once execution for arbitrary tools. A process can die after
an external effect and before its outcome is stored. Strategy plugins must model
that gap explicitly; an event ID or checkpoint alone cannot make a remote write
idempotent. Event delivery failures stay pending for host retry ticks, without
model status polling.

## Trusted strategy plugins

See [plugin API](plugins.md). Register one implementation in an explicitly enabled
local ESM module:

```js
export default {
  apiVersion: 1,
  activate(api) {
    api.registerDispatcher({
      name: "local-check",
      version: 1,
      replaySafe: true,
      async execute(task, context) {
        if (context.signal.aborted) throw new Error("Cancelled");
        // A pure calculation: no ambiguous external write to reconcile.
        const answer = `Input length: ${task.input.length}`;
        await context.checkpoint(answer);
        return answer;
      },
    });
  },
};
```

Select `dispatcher.strategy: local-check` and configure the module in `plugins`.
`direct` cannot be registered by a plugin. Strategy metadata is snapshotted;
changing the source object after registration does not change replay permission.

`execute(task, context)` receives a task snapshot and returns a string (at most
64,000 characters). The context supplies `signal`, `checkpoint(string)`,
`intent(key, "safe" | "unsafe")` and
`settleIntent(key, result, checkpoint)`. All mutations are fenced by the active
claim: a revoked worker cannot commit checkpoints/results. `context.status(text)`
saves a bounded progress message; the host delivers it mechanically, without a
Main model turn. `context.question(text)` durably saves a correlated question,
revokes the claim and throws to suspend execution (do not catch it and keep
working). It requires no unresolved effect intent. The slot is released only
when the strategy unwinds. The operator can answer through `/dispatch answer`,
or Main can use `plugin_dispatch` action `answer` with `id`, `questionId`, `answer`
under its existing authorization. Cross-parent, stale or duplicate answers fail.
A pending unanswered question cannot be bypassed with `resume`. Execution restarts
from the saved checkpoint with `task.question.answer`; it is not a new worker
loop waiting in memory. Questions and status delivery use stable event IDs and
pending ledger events across restarts. They do not themselves grant authority. Save an intent before
an external effect, and settle it only once its outcome is known. One intent can
be unresolved at a time. The last settled effect's key/result is retained in the
task snapshot across restarts; a plugin must recognize it where replay matters.
A `safe` intent is replayable only when the currently registered matching strategy
version also declares `replaySafe: true`. Do not declare safety for an opaque
model/tool turn or an external operation lacking an idempotency contract.

## Parent decision delivery (source interface)

A compatible bundled dispatcher plugin exposes `plugin_dispatch` action `decide`
with `id`, a stable `requestId`, and `decision` text, and the admin command:

```
/dispatch decide <execution-id> <decision-request-id> Accept the documented temporary-file deviation; retain all original constraints.
```

The authenticated host session supplies the parent scope; model arguments cannot
select another parent. Nested dispatcher/subagent workers cannot record decisions.
The command uses the host's admin authentication gate (including for other
`/dispatch` command actions). Model-tool access remains the existing parent-session
tool policy, not an independent permission or authority grant.

`Dispatcher.decide` and `ExecutionStore.recordDecision` durably append an audit
receipt. The reply's `recorded: true` means acceptance only. `state: pending` means
not yet consumed at a strategy boundary; `applied` means delivered to strategy code,
NOT approval of a deviation, evidence, effects or task completion. Inspect bounded
`status` with `id` and `field: decisions` for exact text and receipt readback, or
ordinary status for receipt summaries. `/dispatch status` also includes receipts.
`appliedClaim` is a hash for correlation, not a live ownership token.

Request IDs are 1–128 ASCII letters/digits/`._:-`, starting with a letter/digit;
text must be nonblank and at most 4,000 UTF-8 bytes. Each execution retains at most
32 decisions and 16,000 UTF-8 bytes of JSON decision input. Reusing an ID with
byte-identical text returns its existing receipt without another event or wake;
changed text conflicts. IDs are scoped to that execution. Cancelled, completed,
parent-stopped and foreign executions reject all writes, including retries; read
the retained receipt instead. Audits survive reload and terminal compaction.

Only opted-in trusted strategies accept this interface. Sequential execution opts
in with `decisionBoundary(task)`, which proves a matching retained settled step
assessment before waking a deferred/blocked assessment. A bare ambiguous intent,
recovery-policy block, manual pause or unanswered question is not bypassed. Other
strategies reject `decide` explicitly rather than pretending to consume it.

`DispatchContext.decisions()` delivers and durably marks receipts under the owned
claim. New decisions never revoke an active token, steal a claim, abort a worker,
or clear intent. Workers drain normally. `fenceDecisions(revision)`, revision-aware
`intent` and `settleIntent`, and the host's completion/deferral checks discard stale
verdicts at assessment/claim boundaries. The dispatcher yields only its own drained
claim, retaining evidence and intent for re-assessment, not replay.

Sequential worker and assessment prompts include parent decisions as scoped data
under the original mandate. The independent assessor may accept an explicitly
documented planning deviation using retained evidence; it must still check actual
evidence and every original permission, safety and review/CI constraint. It may
then complete that same original step and run its original successor without
replaying settled effects. An applied decision may still leave a task blocked.
`resume` is control only: task text is rejected; use `decide` for scoped steering.
The minimal tool call is `{action:"resume", id:"<existing-owner>"}` with an
optional nonempty `requestId`. For native transports that require every schema
property, the only supported non-null placeholder envelope adds **all** of:
`task:"", taskId:"", questionId:"", answer:"", decision:"", offset:0, limit:1,
field:"input", charOffset:0`. This exact empty envelope has no steering meaning;
partial envelopes, unknown fields, nonempty text and non-default values are
rejected. PI's nullable optional placeholders continue to normalize to absence.
These shapes do not change parent ownership, worker restrictions, manual pause,
approval or uncertain-effect reconciliation fences.

Failed sequential assessments retain `assessment.failure` in the bounded
checkpoint alongside the existing diagnostic category, attempt count and retry
time. Its fixed `cause` distinguishes `timeout`, `provider_error` and
`invalid_shape`; an allowlisted network `code` and numeric HTTP error `status`
may accompany a provider error. No exception message, stack, URL, header,
prompt or model response is retained. `unavailable` and `inconclusive` remain
separate categories. Older checkpoints contain no recoverable detailed cause.
This is observability, not a retry-gate bypass: existing due-time scheduling and
new scoped decision fences re-assess the retained result without replaying the
worker. A decision receipt alone is neither successful assessment nor progress.

Cross-repository development: use the new core and plugins sources together via
the documented local materializer lock. Production publication must pin the
immutable plugins revision/hash in `plugins.lock.json`; an old adapter lacks the
new surface, and a new adapter on an old running host rejects decisions with a
compatible-host-upgrade error. The adapter's optional-capability projection also typechecks against older host
contracts; it never emulates a missing decision API. Builds do not activate this feature: rollout and restart belong to an
external authorized operator, not this source-only worker.

A strategy may perform work itself or use a separately configured external system.
The current context does not expose a Harness object or a managed-subagent API;
registration alone does not provision workers, credentials or backend access.
Observe `signal` and wait for actual worker termination before returning on
cancellation. Restart after code/configuration changes; a build does not activate
them in an already running process.
