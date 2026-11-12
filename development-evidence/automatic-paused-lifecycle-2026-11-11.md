# General automatic recovery of internal dispatcher pauses

## Root cause

This is a general lifecycle defect, not a repair of one execution. Internal
strategy, configuration and semantic-assessment failures all use `runtime-failure`.
`ExecutionStore.fail` previously retained them as `paused` (without intent) or
`blocked` (with intent). Scheduling claimed only `ready`, and automatic recovery
matched only `worker-failed`. Startup recovery similarly skipped paused records.
The parent supervisor could propose a DIFFERENT independent parent step, but did
not resume the same child. Thus internal pauses were durable dead ends.

A second defect gave a worker's self-reported blocked label veto power over the
independent reviewer's completed verdict unless extra parent decision data existed.
That made an unnecessary parent nudge part of normal progress.

## General lifecycle change

- Internal `runtime-failure` and `worker-failed` receive a persisted due time and
  exponential backoff; no lifetime continuation cap.
- The existing dispatcher scheduler promotes due internal pauses to ready and
  claims the same execution ID. Cheap ticks do not move the due time. Diagnosed
  legacy internal pauses are adopted, and restart restores the same due time.
- Reconciliation-capable strategies only. Unanswered questions, manual pauses,
  cancellation, authentic expiry, unknown classifier send outcomes and trusted
  recovery policy remain binding. No arbitrary exception text grants replay.
- Sequential retained assessments are independently re-evaluated without executing
  the already-settled worker again. A genuine blocked verdict does not run effects
  or admit a successor. Independent completion can override a worker-authored
  blocked label without a parent nudge. Effect-bearing inadequacy retains evidence.
- Genuine holds clear automatic retry ownership; expired retries become explicit
  deadline holds even before their backoff is due, including ready worker retries.
- Notification events carry bounded host retry metadata. Timed automatic pauses
  update routine status instead of asking the user to resume; actual questions
  and manual pauses remain attention messages. Plugin tool/command diagnostics
  use the same distinction.

## Verification and review

General tests cover internal paused and blocked states, new and legacy records,
persistence/reload, same-ID wake-up, non-renewal of backoff, retained intent,
explicit holds, transition to a new genuine hold, and expiry before retry due.
Real Harness/DispatcherRuntime/sequential tests prove independent completion and
re-assessment after restart with zero repeated settled worker turns.

Final pinned integrated core suite: 1,848 total, 1,847 passed, 0 failed, 1 skipped;
companion plugin suite 91 passed, 0 failed. Final targeted lifecycle/sequential/
notification run: 83 passed. Build/typecheck passed. A typed semantic hold keeps
one actionable attention notification while independent reassessment remains
scheduled; automatic recovery must never hide a genuine external resolver.
Independent supplied-diff reviews identified stale retry ownership and ready-retry
expiry edge cases; both were corrected with causal regression coverage. Upstream
settings fix was normally merged, not reverted. Final complete CI remains required
for the published exact head.

No live execution data was edited or reset, no one-off resume was used as a product
fix, and no Main implementation fallback was introduced.
