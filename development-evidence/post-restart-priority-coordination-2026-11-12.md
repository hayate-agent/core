# Post-restart coordination and durable priorities

## Report and reproduction

Akira had selected Core `1f1d39d54d29` (#368) and delivered its readiness notice. Durable state still contained three current-enrollment active operator tasks: one older task already queued/running; two other tasks, including the promised activation verification, had expired assessment backoffs. The verification had not become runnable. Read-only host inspection did not edit its ledger or inject another Matrix request.

The initial new regressions reproduced three independent gaps on that revision:

- An enrolled waiting task without a polling timer was never independently reconsidered on restart.
- An unavailable assessment became a permanent blocked task instead of preserving the existing bounded read-only retry mechanism.
- A continuously continuing task queued itself before another due retained assessment could run. Other retained tasks with saved next-step prose were also excluded from the between-turn assessment loop.

`post-restart-baseline.log` outside the repository records these failures. Existing semantic-uncertainty regressions distinguish a genuine `inconclusive` verdict from technical unavailability; that distinction is retained.

## Scheduling contract

`priority` is explicit host-owned scheduling metadata on the durable Main task. Missing values mean normal. It survives state save/restore, is copied into the host-derived Dispatcher dependency snapshot, and the Dispatcher consults the live durable parent when available. Worker tool arguments do not assign it. Updating a parent therefore immediately affects its pending Dispatcher admissions without trying to transactionally rewrite a second ledger.

`/task-priority <task-id> high|normal|low` is an administrator command in the current conversation. `plugin_task_priority` lists bounded task metadata and can persist an explicitly requested preference only from authenticated interactive operator ingress. Worker/automatic turns cannot promote themselves. Priority never changes a task's grant, dependency custody, polling deadline, repetition budget, hold or terminal state, and never preempts an in-flight effect.

Main and Dispatcher prefer the highest runnable priority with round robin among equals. One of every five scheduling selections yields to lower priorities, round robin, to prevent permanent starvation. This fairness cursor is bounded in-memory scheduling state; the explicit priority is durable. Foreground operator ingress retains precedence over autonomous work.

At safe Main turn boundaries, at most one other due retained assessment is attempted before scheduling continuation. Other already-admitted work can receive its next bounded turn. A startup-only recheck of current-enrollment timerless waits is deferred, not lost, if another restored turn already occupies the session. A valid independent waiting/blocked decision remains a hold, not a productive retry grant.

## Parallelism boundary

Dispatcher `capacity` bounds concurrent independent executions, not Main turns. A `sequential` strategy orders steps inside one execution; it must not globally serialize independent executions. No configured capacity is increased by this change. The integrated regression restores two parent tasks, delegates each under its own original mandate, and proves both worker promises are running simultaneously before either is released, with no post-restart user input.

This does not introduce a DAG planner or claim to automatically split one compound delegation into independent executions. It does not grant concurrent writes to shared worktrees or bypass existing isolation/safety requirements.

## Validation

- Focused post-restart regression: six cases, including expiry, explicit stop/block, global pause, timed waiting and held legacy preservation.
- Priority regression: persistent preference and terminal hold preservation; bounded preference/fairness; operator-only metadata mutation; queued child snapshot persistence; real overlapping Dispatcher execution; integrated Main-to-Dispatcher overlap after restore.
- The PR workflow includes Harness/assessment/priority paths and executes the complete CI suite, rather than silently skipping this class of change.
- Full suite, independent review, merge and live native activation evidence are tracked separately; no live deployment is claimed by this document.
