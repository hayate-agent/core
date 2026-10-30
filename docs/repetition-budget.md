# Task repetition allowance (v1)

The ceiling is **20 consecutive unevidenced productive attempts**, not 20 turns
and not queue depth. A productive turn with fresh host evidence ends that stagnant
run. `depth` remains the monotonic queue/dependency identity; it is never reset.
The original mandate, expiry, admission, pause/stop, dependency and permission
checks still apply. Review and recovery-assessment budgets remain independent.

## Minimal evidence boundary

The CLI samples tracked Git working-tree bytes before/after the productive turn.
No credit is granted for model claims, changed plans/tool arguments, tool output,
call IDs, timestamps, untracked files, commit metadata, unchanged snapshots or
previously observed snapshots. No tool-result observer or new model-facing field
is involved. A snapshot failure or absent Git repository consumes allowance.
Overlapping turns in this Harness cannot claim each other's evidence: any overlap
invalidates credit for both. External processes remain outside this attribution
boundary. The snapshot records tracked bytes, including deletions, not Git HEAD.

This is conservative **evidence of distinct local work**, not proof that a change
is useful or tests passed. Novel arbitrary tracked edits can qualify; determining
semantic usefulness without a trusted domain evaluator is ambiguous. Non-code
research, remote effects, untracked new files and unchanged successful tests do
not currently qualify. Evidence history is capped at 256 hashes; when full no
further automatic progress credit is granted. Deadlines are never renewed by
progress. This deliberately does not provide unlimited autonomy for any domain.

The versioned task `repetition` record stores the current run, total attempts and
seen hashes. Seen hashes survive operator reset. Queue identity `depth` and its
existing epoch/audit remain separate. Old tasks with no v1 record conservatively
use their old depth until the next accounted attempt or authenticated reset;
there is no silent migration/reopening of exhausted live tasks. Settled execution
turns carry the repetition record, so recovery projects it without repeating a
completed effect. Existing settled turns lacking this record remain conservative.

Pure dependency status polling is separate: `waitChecks`, minimum interval and the
original fixed deadline bound it; it neither consumes nor replenishes repetition
allowance. The first productive tool inside a wait is charged durably before the
effect and receives no speculative evidence credit. Parallel tools share that
charge barrier. New operator scope requires a new operator request as before.

`/task-budget` authentication, compare-and-swap token, persistence barrier and
request dedup are unchanged. Reset changes the repetition run (or the separately
classified recovery budget), not queue depth, seen evidence, total attempts,
review budget, deadlines or unrelated tasks. No live reset is part of rollout.
