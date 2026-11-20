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
