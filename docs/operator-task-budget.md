<!-- SPDX-License-Identifier: Apache-2.0 -->

# Authenticated operator task-budget control

This command repairs an exhausted **retained chat task**, not a dispatcher worker,
review budget, provider limit or integration login. It is not a model tool.
Use the attached local console/TUI or a configured administrator identity through
an authenticated channel. Remote `openAdmin` alone is deliberately insufficient;
API, host, timer and model-origin command invocations are rejected. Channel
adapters remain responsible for authenticating their sender metadata, as for
other admin commands. Do not expose a local console to untrusted callers.

Exact invocation (IDs and session keys must not contain whitespace):

```text
/task-budget inspect <session-key> <task-id>
/task-budget reset <session-key> <task-id> <inspect-token> <unique-request-id>
/task-budget inspect <session-key> <task-id>
/task-budget resume <session-key> <task-id> <new-inspect-token> <another-unique-request-id>
```

`inspect` returns the exact retained checkpoint, its receipts and a SHA-256
stale-state token. Obtain session keys through `/status` or `/sessions`; task IDs
are the host-assigned retained checkpoint IDs (also available in persisted session
state). Never guess an ID from an external integration target.

For a single explicit authorization to reset **and** resume, use instead:

```text
/task-budget inspect <session-key> <task-id>
/task-budget reset-resume <session-key> <task-id> <inspect-token> <unique-request-id>
```

`reset-resume` uses the same eligibility, authentication, stale-state, audit,
deduplication and atomic-save boundary as `reset`, but commits the active state
in that transaction. Normal recovery/scheduler admission runs only after the save.
A save failure cannot leave a half-reset or running task.

`reset` and `reset-resume` accept a host-classified productive-budget exhaustion
(20 consecutive attempts without new host evidence; see [repetition accounting](repetition-budget.md)), recovery-assessment exhaustion (3 attempts), or the narrow legacy
checkpoint shape: **active**, depth **exactly 20**, with no `termination`,
`explicitBlocked`, `recoveryAssessment` or `recoveryRetry` field. This supports
pre-classification active exhausted checkpoints without classifying their history.
Other active shapes fail closed. It clears only exhausted counters:
the versioned repetition run and/or recovery retry/assessment markers.
Queue `depth`, total attempts and seen evidence are preserved. It leaves the task
**blocked**, records `operator_budget_reset`, and executes nothing. An arbitrary
agent/operator `blocked` decision is not resettable, even at depth 20. Legacy
unclassified blocked checkpoints fail closed; no text interpretation promotes
them to authority.

`resume` is separate explicit operator authorization to resume the same original
scope under unchanged permissions/deadline. It requires that committed reset and
a fresh token. It marks the task active; normal scheduler/recovery admission and
approval/review gates apply. If no safe next step exists, bounded recovery
assessment must establish one. It cannot resurrect stopped/completed/expired
work, bypass pause, or extend a wait deadline. Commands require an idle host
boundary: if another turn, intake, delivery or control is active, retry later.

All mutating actions persist the checkpoint and receipt in the existing atomic state-file
transaction before subsequent execution. Save failure restores the previous
in-memory checkpoint and reports failure. Concurrent controls fail closed; a
changed task invalidates the token. Identical `(task, request-id, action, token,
actor)` retries return the original receipt without a second reset, including
after restart. Conflicting reuse is rejected. The newest 16 receipts **per task**
are retained, preserving prior depth, retry attempts, assessment and termination
and attention markers. Once evicted, an old request cannot override a fresh token;
use a new unique request ID. This is a bounded audit, not an unbounded event log.

A new host-generated queue epoch prevents collision with already accepted
continuation IDs. Old accepted IDs, inbox/outbox, completed effects, worker
admissions and review histories are not erased. `waitChecks` remains monotonic;
it is an identity sequence, not a resettable budget. Only exhausted-budget
attention markers are cleared for the new epoch; old notification entries and
receipt evidence remain. Future exhaustion may emit one new epoch-scoped notice.
No global budgets, original authority, external credentials or deadlines change.

The host exhaustion notice includes a short original scope, pending next step
(or an explicit unknown), why work paused, and the exact session/task-specific
`inspect` and `reset-resume` command sequence. Legacy active exhausted tasks also
receive that once-only durable notice. Already persisted/delivered old notices are
not rewritten or resent by an upgrade.

Natural-language requests to the chat model are **not** authenticated command
ingress. The model cannot execute these commands by printing them, forge sender
metadata, or reset its own budget. An operator must submit the command through
the authenticated channel or local console; this patch adds no natural-language
intent-to-command bridge. The inspection token and request ID remain explicit.

See [task recovery](task-recovery.md), [bounded waits](task-waits.md),
[budget attention](budget-attention.md) and [operations](operations.md).
A build or commit does not activate the feature in an already running Harness.
