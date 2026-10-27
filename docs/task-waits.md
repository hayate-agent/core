# Durable bounded task waits

`plugin_task_continuation` can register an explicit timed recheck within a running,
authorized task:

```json
{"state":"waiting","next":"Read the release source and image digest; reconcile completed rollout before any action","wait":{"reason":"Image containing the approved source revision has been published","retryAfterMs":300000,"deadline":1793100000000}}
```

The deadline is an absolute UTC millisecond timestamp, greater than the next check
and at most seven days ahead. Intervals range from one minute to 24 hours. The
original task's earlier deadline always wins. A later wait cannot extend the
inherited deadline. The existing 20-follow-up cap includes wait rechecks.

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
sessions and unavailable persistence suppress wakeups. Expired or exhausted waits
become blocked and post a visible operator-review notice without starting a model
turn. Stop revokes the task. New accepted operator work retains the existing task
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
