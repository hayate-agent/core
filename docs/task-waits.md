# Durable bounded task waits

`plugin_task_continuation` can register an explicit timed recheck within a running,
authorized task:

```json
{"state":"waiting","next":"Read the release source and image digest; reconcile completed rollout before any action","wait":{"reason":"Image containing the approved source revision has been published","retryAfterMs":300000,"deadline":1793100000000}}
```

The deadline is an absolute UTC millisecond timestamp, greater than the next check
and at most seven days ahead. Intervals range from one minute to 24 hours. The
original task's earlier deadline always wins. A later wait cannot extend the
inherited deadline. The 20-follow-up cap counts productive work, not host-issued status-only rechecks.
Each scheduler claim persists a monotonic `waitChecks` sequence and an inbox
`waitCheck` marker. IDs use that sequence, not work depth. The runtime tool guard
exempts only `plugin_dispatch` with action `status` and the continuation checkpoint
tool. All other tools (including shell, web, read and arbitrary plugin tools)
acquire and persist one productive step **before** execution in a recheck turn.
A failed save denies execution. Repeated tools in that turn charge only once;
returning `waiting` cannot refund the step. At depth 20 status checks may continue,
but productive tools are denied and `continue` becomes a blocked checkpoint.
A status-only turn requesting `continue` queues the ordinary next productive step.
Model prose and tool names claiming to be read-only are not evidence of purity.

The host persists the condition description, safe next step, due time and deadline
with the ordinary turn checkpoint. On the first idle scheduler tick after due time,
it atomically claims one recheck through the normal durable inbox acceptance
barrier. Restart preserves waits; overlapping ticks do not duplicate a claim.
Persistence failure holds the queued input, never executes it early. A wakeup is a
bounded working turn that verifies the actual condition: it is NOT proof that the
condition holds and grants no extra authority. If still waiting, the agent must
explicitly register another bounded wait. Original mandate and deadline accompany
the recheck. Existing replay reconciliation, tool guards and approval rules apply.

Pause, stop, queued operator work, active turns/delivery, externally managed worker
sessions and unavailable persistence suppress wakeups. Expired deadlines and malformed checkpoints become blocked without starting a
model turn. `termination` distinguishes `deadline_expired`,
`productive_budget_exhausted` and `malformed_checkpoint`; next step and dependency
remain inspectable (the last claimed dependency is retained as `lastWait`). Routine
termination is logged as lifecycle activity, not posted as a generic operator-review
alarm. This patch deliberately adds no competing notification integration; a future
notification adapter can consume these reasons and request a concrete human decision
only where one actually exists. Stop revokes the task. New accepted operator work retains the existing task
supersession behavior. API runs and the nightly controller cannot register these
waits; they retain their own lifecycle contracts.

Plain `waiting` is still allowed for genuinely operator-dependent work, but its
tool response explicitly says **no automatic wakeup registered**. Merely writing
`next` alongside plain waiting does not schedule work. The optional wait object
is required for an external-dependency recheck.

This implementation uses the existing Harness scheduler; it does not install a
Forgejo webhook, subscribe to release infrastructure, perform network polling in
Core, or create an unrestricted recurring job. `reason` is evidence to inspect,
not an executable expression. Timer latency includes the normal scheduler tick
and idle time. Artifact/status claims are not independently verified by scheduling.
A source build or merge does not activate a running deployment.

## Diagnosing authority denials

When an execution store is configured, the actual wait tool guard writes a
host-owned `waitAuthorityDenials` ring in the existing execution ledger
(`executions.json`). Inspect it locally, or use the host-only
`ExecutionStore.waitAuthorityDenials()` accessor. These are not outgoing execution
events, are not injected into model context and confer no authority. The newest
100 receipts are retained globally (oldest evicted; no separate time expiry).
Existing ledgers without this optional field remain readable.

Each receipt contains only `reason`, host `taskId`, `waitSequence`, optional
`taskWaitSequence`, optional durable `turnId`, and `at` (UTC epoch milliseconds).
IDs are capped at 128 characters. No session routing address, tool name/arguments,
transcript, condition prose, exception text or task contents are recorded.
Reasons follow the original short-circuit guard precedence:

- `cancelled`: Harness stopping (checked first), or the turn is being cancelled;
- `ownership`: this input no longer owns the current turn (before turn cancellation);
- `deadline`: inherited deadline missing/invalid or reached;
- `missing-task`: host task identity cannot be found;
- `stopped-task`: the matching task was explicitly stopped;
- `sequence`: the claimed recheck sequence no longer matches the task.

Checks run before exemptions (including status and checkpoint tools), and again
after the productive charge persistence barrier. Valid-path charge ordering and
budget accounting are unchanged. A diagnostic persistence failure still denies
the tool, emitting only a fixed host log message; no raw exception is forwarded.
Without an execution store the same denial applies, but no receipt is retained.
Model-facing denials use fixed, sanitized host codes: `deadline_expired` for a
positively established elapsed execution deadline, `execution_cancelled` for
stop/cancellation, `ownership_lost` for a stale turn or wait sequence, and
`parent_mandate_missing` when no live parent mandate is available. Invalid deadline
metadata and otherwise unclassified revocations retain `authority_revoked`.
These codes do not renew authority or impose a global build/deployment ban.
Arbitrary exception messages are never forwarded; receipt storage is unchanged.

This is prospective instrumentation, not a repair or retrospective diagnosis of
the historical PR72 denial: its exact failed predicate was not recoverable from
retained evidence, and the preserved ordinary chronology fixture passes unchanged.
