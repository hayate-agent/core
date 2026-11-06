<!-- SPDX-License-Identifier: Apache-2.0 -->

# Prepared handover recovery retry pacing

A prepared handover is a durable checkpoint, not proof that the replacement
session was seeded and archived. Foreground work must remain fail closed until
that recovery succeeds. The per-conversation maintenance queue therefore still
serializes foreground guidance with active maintenance; this change does not
make compaction concurrent with a working prompt or cancel maintenance on arrival.

Previously both `guidance` and pre-turn recovery retried a failed seed/archive
link on every arrival, bypassing the ordinary failed-maintenance turn cooldown.
Turn cooldown cannot pace this path: a blocked working turn never advances it.

After a failed prepared recovery, persist `recoveryRetry` with an attempt count
and absolute `notBefore`. Delays are 1, 2, 4, 8, 16, 32, then 60 seconds (capped).
The first second coalesces immediate repeated boundary/guidance arrivals; the
60-second cap keeps recovery eligible without an unbounded foreground outage.
These are retry intervals, not new operation deadlines. Existing provider abort
and maintenance deadlines are unchanged. The clock is injectable for tests.
Restart, status reads and arrivals do not slide the deadline or reset attempts.
At/after the deadline the next arrival can attempt recovery; no background job
is invented. While waiting, surface the retained safe stage/code failure without
retrying seed/rotation/link effects. No working prompt is authorized by the wait.

Successful recovery clears retry state; checkpoint, pending intent, archive
identity/history and seed checkpoint semantics are unchanged. An explicit new
request does not bypass an unresolved recovery failure. No global maintenance
disable, task-budget change or claim of exactly-once external effects is made.

The causal fixture deliberately stalls a fake compact operation and demonstrates
same-key foreground guidance waiting while another conversation completes. It
makes no provider/model calls and does not establish the cause of a historical
production warning or a safe way to run foreground work concurrently with a
mutating session. That foreground issue remains separately open.
