# Optional durable dispatcher

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
`capacity: 1`, `retentionDays: 7` (integer, 1–3650). Enabling requires the operator's explicit declaration that the
configured runtime/backend supports concurrent requests. This declaration does
not probe or configure the backend. Capacity limits active strategy executions,
not the number of retained tasks or configured persistent workers. The runtime
must also have headroom for Main, approvals and review requests.

`direct` is the reserved built-in strategy: one ordinary isolated Harness turn
per task. It uses the configured runtime rather than calling PI directly. It
cannot spawn nested subagents, schedule loops, submit further dispatcher work or
authorize continuations. Approvals route to the trusted parent conversation.
Plugins can supply other execution strategies; they are trusted process code,
not sandboxed workers. Main cannot select replay policy in a tool call.

`sequential` is an opt-in reserved built-in plan-and-execute strategy on the same
scheduler, ledger and worker bridge. It requires enabled [model roles](model-roles.md):

1. One tool-free ephemeral planner turn on the exact `dispatcher` role returns a
   closed JSON plan of 1–6 steps, each with the lowest adequate role
   (`simple`/`medium`/`high`), a reason and the evidence it must prove. A single
   simple step is valid. Malformed output is a visible block, never repaired.
2. Plan, step index and outcomes are persisted in the execution checkpoint before
   any worker turn; each step saves an unsafe intent with its exact route first.
3. Steps run sequentially as ordinary worker turns in the task-bound session with
   the original task as authority. Deadline, parent stop and ownership are checked
   before every step; approvals keep trusted parent routing. Prior outcomes are
   passed as untrusted data.
4. A step counts only with a final `STEP-STATUS: complete` line; anything else
   pauses the task with a visible reason. The final result lists requested and
   observed model per step and is produced only when every step completed.
5. Roles are used exactly: an unconfigured or unavailable role blocks visibly
   instead of silently using the default model. Technical planner failures never
   switch models. A step reporting `STEP-STATUS: inadequate` without any tool call
   is retried once one role higher; otherwise the limit is reported.
6. Restart resumes from the persisted plan without replanning. An unresolved step
   intent uses the existing transcript reconciliation; without retained evidence
   it blocks for explicit operator resolution. Effects are never replayed blindly.

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

The built-in direct strategy saves an **unsafe intent before an opaque runtime
turn**. An interrupted turn with unknown external effects becomes `blocked`;
startup never independently replays its old Harness inbox or continuation. A
settled turn retains its result before the final completion commit, so a restart
in that gap returns the saved result without another worker turn. Unknown
strategies, changed versions and repeated interruptions also block automatic
recovery. An unsafe blocked task has no automatic reconciliation command: inspect
actual external effects before making a separate authorized submission. Do not
edit ledger files while the Harness is running.

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

A strategy may perform work itself or use a separately configured external system.
The current context does not expose a Harness object or a managed-subagent API;
registration alone does not provision workers, credentials or backend access.
Observe `signal` and wait for actual worker termination before returning on
cancellation. Restart after code/configuration changes; a build does not activate
them in an already running process.
