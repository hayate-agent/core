# Assessment continuation and recovery

A failed independent assessment is not evidence that its mandate is complete or
permanently blocked. Read-only assessments use persisted exponential backoff:
1, 2, 4, 8, 16, 32, then 60 minutes between failures. There is no total assessment
attempt ceiling. Existing mandate deadlines, parent stops, approvals, unresolved
worker effects and host no-progress safeguards remain authoritative.

## Scheduling and cost

- Reuse the existing host tick and dispatcher retry tick; no additional scheduler,
  model-based watchdog, or status-polling agent.
- Due-time tests are ordinary local comparisons. Not-due ticks make no model calls.
- A sequential step retains its settled report and bounded tool evidence before
  assessment. One assessment runs per due claim. On an unusable result, the
  execution becomes `ready` with a persisted `assessmentRetryAt`; it releases its
  dispatcher slot. Repeated inference never reruns the worker effect.
- Successful `continue` verdicts cannot bypass pacing: if the following settled
  correction contains no novel successful tool-result receipt, persist a
  no-progress counter and the next assessment due time, then release the slot.
  Identical notes or changed prose neither terminate work nor reset pacing.
  A successful novel tool receipt resets the counter. A bounded 64-receipt recent
  window detects repeated observations, including short A/B cycles; it is not a
  proof of semantic progress and cannot detect every long-cycle repetition.
  Tool-free reasoning remains authorized but runs at the backoff cadence until
  new evidence is observed. There is no lifetime correction count ceiling.
- The reservation and its due time are checkpointed before inference so a crash
  does not reset the retry sequence. Startup reconciles retained evidence.
- Preserve the actual worker transcript across assessment-only claims. Only an
  independently authorized correction may transfer that transcript into a new
  worker session. A retry timestamp itself is not a replay grant.
- A ready/running child already owns its recovery; its parent does not launch a
  second independent assessment of that same work.
- The host tick also checks idle active mandates with a saved next step but no
  queued/running/admitted continuation. They enter the existing read-only
  admission path rather than being stranded indefinitely. Stops, deadlines,
  queued input, pending dependencies and admission receipts are checked first.

At sustained assessment failure, each eligible task is assessed at most once per
hour after ramp-up. This bounds retry frequency, not total authorization. A large
number of independently open mandates still has aggregate cost; this is not a
claim of a global spending limit.

## Diagnostics and safety

Recovery diagnostics remain channel-gated (default off), privacy-safe, persisted
with their delivery identity, and deduplicated per task/budget epoch. Sequential
assessment diagnostics are a distinct dispatcher status: their event and per-step
receipt are committed atomically with the failed assessment checkpoint, so a crash
before yielding the slot cannot lose the notice or regenerate it on each retry. Reporting a
retryable failure does not block or terminalize an active task. Unknown child
worker effects remain fenced; retrying assessment does not resume/cancel/resolve
or replay the child. A valid semantic blocker does not get automatic technical
retries.

Legacy terminal `recovery_assessment_failed` tasks are not automatically revived.
Their existing explicit operator reset path remains supported. Old queued
diagnostics are sanitized on restore, including pending diagnostics of active
retryable tasks. Existing stops and original deadlines are not extended.

## Verification

Relevant regressions cover more than three failures, saturating backoff, JSON and
disk restore, a crash after reservation but before yielding, zero pre-due inference,
slot release, one diagnostic including a checkpoint-to-deferral crash, twelve
identical tool-free corrections with increasing due times, seventy evidenced
corrections without a lifetime ceiling, restart/cancellation of paced work,
original scope/deadline fences, unknown child effects,
manual pause/approval/stop, and announced-but-unqueued actions executing once.

This is source behavior, not a deployment instruction. A local build does not
activate this implementation in running agents.
