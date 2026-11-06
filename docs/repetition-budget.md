<!-- SPDX-License-Identifier: Apache-2.0 -->

# Task repetition allowance (v1)

The ceiling is **20 consecutive stalled or unevidenced attempts**, not 20 turns
and not queue depth. Fresh tracked-tree evidence or a distinct substantive milestone
from the independent completion assessor ends the stagnant run. Verification,
research and analysis do not require file edits. Checker invocations and nudges
are not themselves retries. `depth` remains the monotonic queue/dependency identity.
The original mandate, expiry, admission, pause/stop, dependency and permission
checks still apply. Review and recovery-assessment budgets remain independent.

## Minimal evidence boundary

The CLI samples tracked Git working-tree bytes before/after the productive turn.
Git credit excludes model claims, changed plans/tool arguments, call IDs,
untracked files, commit metadata, unchanged or previously observed snapshots.
A snapshot failure or absent Git repository does not prevent the independent
continuation or tool-result accounting below.
Overlapping turns in this Harness cannot claim each other's evidence: any overlap
invalidates credit for both. External processes remain outside this attribution
boundary. The snapshot records tracked bytes, including deletions, not Git HEAD.

This is conservative **evidence of distinct local work**, not proof that a change
is useful or tests passed. Novel arbitrary tracked edits can qualify; determining
semantic usefulness without an evaluator is ambiguous. The existing independent
completion assessor can additionally return optional `progress: {advanced,
fingerprint}` naming a substantive milestone based on bounded tool observations
and conversation evidence. Core accepts it only from the assessor, not the working
model's continuation tool. Changed prose, turn IDs, unchanged polls and repeated
fingerprints give no credit. Fingerprints are hashed into the existing persisted
history and survive restart/operator resets; this is advisory semantic evidence,
not proof of usefulness or an authorization grant. Missing/malformed/failed
assessment remains conservative. Evidence history is capped at 256 hashes; when full no
further automatic progress credit is granted. Deadlines are never renewed by
progress. This deliberately does not provide unlimited autonomy for any domain.

A successful analysis/control-only turn independently assessed as `continue`
without an explicit `progress` verdict does not consume the stall allowance or
clear earlier stalls. Explicit progress verdicts retain the milestone/replay rules
above. Working-model plans alone never qualify. No replacement turn ceiling is
introduced; original authority and expiry remain binding.

Successful complete runtime tool results additionally receive a turn-local hash
of ordered `[tool name, result detail]` pairs. A fresh hash resets the stall run;
identical, failed, missing or unfinished results do not. Continuation and context
maintenance tools are control-plane nudges, not work receipts. Call IDs, arguments
and model prose are excluded. Hashes share the existing 256-entry persisted history.
Changing timestamps in result details can appear distinct; receipts establish
observed results, not usefulness or permission for remote effects. Bounded assessor
tool context remains unchanged. Pure polling should use the bounded wait path.

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
