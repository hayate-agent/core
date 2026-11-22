# API runs own their delegated work

Hermes-gateway callers such as Paperclip only let an agent write (issue comments, status
changes) while their heartbeat run is still running. The request has to carry that run's
`X-Paperclip-Run-Id`. Before this change, a Hayate API run finished as soon as Main's turn
replied. When Main had delegated work to the dispatcher and replied with an interim status,
the caller closed its run, and the worker kept going for hours without write authority.
Typical errors were `401 run_expired` and `Agent run id required`.

This is the current contract:

- **The run stays open.** If an API turn's task still has live delegated work, the API run
  is not finished. Live work means a ready, running or retrying execution, an undelivered
  result, or a queued Main input for that task. The latest answer is published as run status
  (`status.updated`) and held durably on the task as `apiHold`.
- **The final answer finishes the run.** The worker's result returns to Main inside the same
  run. Main's answer to it, or its latest held answer once no work is live, finishes the run.
- **The window is bounded and anchored.** When a fresh API task is accepted, it fixes `apiRunDeadline` (durable API acceptance time + `apiResultHoldMs`, so queue wait counts), which no later reply renews. Its delegated work gets a deadline of
  `apiResultHoldMs − 5 min`. The default hold is 25 min, below the 1800 s heartbeat timeout.
  Workers therefore stop through the existing `deadline-expired` path with their findings
  retained, and the run ends at the hold deadline. If work is still open at that point, the
  answer carries an explicit `Status: blocked` note. The run never pretends the work is done,
  and the caller's next run re-checks the issue and continues.
- **Running workers stop at the window close.** When the window closes, open children are
  revoked (`parentStopped`, and running workers are aborted). The task is marked
  `blocked`/`deadline_expired`. No work continues without the caller's write authority.
- **Stop is honoured.** `POST /v1/runs/{id}/stop` on a held run detaches the held answer
  before any await, stops its delegated work and ends the run as `cancelled`. A concurrent
  tick cannot finish it as completed.
- **Native child results count as live work.** A finished native subagent whose durable result
  has not yet reached Main's inbox keeps the run open.
- **Restarts keep the run.** A held answer survives a restart and keeps its run alive across
  startup reconciliation.

API runs without delegated work behave exactly as before.

The run is released on the host tick and delivered directly to the run (finishing is
idempotent). An unrelated turn running in the same session therefore cannot delay the
deadline.

## Rebinding only while the run owns nothing (KISS)

An API run that owns nothing yet (no delegated work ever submitted for its task, no held or
deferred answer, no revocation fence) may resume an older operator order: its turn is
rebound and its acceptance-anchored window moves, unchanged, to that order's task. Exactly
one task ever carries the run window. As soon as the run owns anything, `reopen`/`clarify`
from its turn is refused before any write (`close` stays allowed), so work, holds and
revocation never move between tasks. No delegated work is admitted while a rebinding is in
flight.

The rebinding is atomic: while it is in flight no delegated work is admitted (native starts
take their checkpoint and insert their record in one synchronous step). "Owns nothing" covers
every child ever started for the run's task (settled native children included, any parent),
and the destination order must own no work of another mandate either. A stop or window close
that begins during the rebinding fences the run immediately and durably on its own task; the
run is then not moved (it ends there) and the order merely stays open. The same holds if
work of another mandate reached the destination during the rebinding's awaits: ownership is
re-checked synchronously right before the move, and once moved the run identity guard
refuses every foreign submission for the destination. The admission guard applies to the task wherever it lives
(also a submission from another session for an order carried by an API run), and native
starts (`dependencyCheckpoint`) apply the same persisted guards as dispatcher submissions. Submissions that passed admission but whose ledger
write is still pending count as live destination work (`submissionInFlight`). Live
destination work is checked across all sessions (dispatcher executions and native
children of any parent). Once moved, no foreign work can attach (the run-identity guard
applies across sessions), so the run's liveness and revocation stay scoped to its own
session. Terminal
history (completed or cancelled executions) of the destination does not block resuming it;
the run's own task, in contrast, counts every child ever started under it. The rebinding is never
refused after its durable decision and binding were written. A finished run clears its task's
window, so a later run can resume the same order.

Admission is bound to the run identity: the task persists the run carrying its window
(`apiRunId`, moved by a rebinding), and work submitted for another API run is refused, so a
delayed submission of an ended run never enters a later run's window on the same order.
Crash consistency: the rebinding persists an intent (`apiRebindIntent`) before its first
durable task-book write, and the run window and identity move only in the final step. Any
interruption (failed write or restart) leaves the run entirely on its own task; a reopened
order is then merely open and carried by no run, so a later run can still resume it. While
an intent is pending no work is admitted for the task; a restored intent is retired. If the
final save of the move fails, both tasks stay fenced (no admission) and the save is retried
until it covers the move. Admission also refuses work once the run's acceptance-anchored
window has passed, even before the tick raises the revocation fence.

A rebinding persists the move-away on the old task (`apiRunEndedAt`), so a stale checkpoint
of the old task stays refused after a restart. A later run resuming an order whose earlier
run ended gets its own bounded authority (its own window), never the expired predecessor's.
When a task's run has ended (`apiRunEndedAt`, persisted) and no run is open, a checkpoint
captured under it admits no delegated work. A late result for a closed or held order is
delivered to an API run as progress only; it never ends a run outside its hold and fence.

After a run ended, only stale API authority is fenced: API-origin or origin-less work under
the ended run is refused, while a later operator mandate (non-API host origin, any session)
can delegate on the order again.

A task carried by an API run takes delegated work only from the run's own session
(submissions from other sessions are refused, whatever their origin), so the run's liveness
and revocation, scoped to that session, see all of its work. From the final liveness check
of the release path until the run has ended, no new work is admitted; submissions admitted
but not yet written keep the run open.

An order is carried by at most one API run across all sessions: the carrier check covers
every session and in-flight rebindings, before any write and right before the move.

Replay exhaustion of an API turn (a turn interrupted too often by restarts) fails the run
through its hold whenever its task carries the run (live work or a restored revocation
fence alike): the release path waits for the fence, revokes the children, ends the run and
retires the task's run window, so the order is not left with a stale carrier.

An expired queued run's `cancelled` result is durably staged and then delivered directly by
the tick, independent of a long-running turn in the same session. A finished run clears
its task's window, so a later run can resume the same order.

This feature is first released with this change; no earlier version persisted run
ownership (`apiRunDeadline` and related fields), so there is no legacy state to migrate.

## No API work without an open run

An API session's task acts only inside its caller's open run. A task without one (its run
ended, or legacy state from before run windows existed) is never resumed by recovery or by a
model-requested continuation, and the tick revokes its still-live delegated work: Paperclip
rejects every write with the ended run id (401 `run_expired`), so the work could only fail.
The next Paperclip heartbeat run for the issue picks the work up with fresh authority.
Already queued internal inputs of such a task (a continuation checkpointed before a restart,
recovery, a dispatcher or native worker result) are dropped before they run, also while its
revocation (live or restored) is in flight; fresh API runs are unaffected. The
revocation runs through the same durable fence as a window close, so no work is admitted and
the task cannot be rebound to a fresh run until the old work is revoked.
Unscoped live workers in an API session are legacy: admission is always task-scoped and an
unscoped result has no mandate, so no run - open or fresh - can own them. The tick holds them
in one serialized ledger step independent of any task's run state (blocked as
`unscoped-parent-stop`, never rescheduled; the dispatcher aborts them), and their queued
results are dropped before they can start a model turn. Work of other sessions is untouched.
Paused or blocked (retryable) executions count as live for both rules, so a retry can never
resume them after the run ended. The owner abort for held legacy workers is retried on every
tick until it succeeds.
Independently of the tick, the dispatcher never schedules or starts such work: its scheduling
filter and the post-claim check ask `Harness.apiExecutionRunnable`, so after a restart nothing
run-less or legacy runs before the first tick has held or revoked it.
