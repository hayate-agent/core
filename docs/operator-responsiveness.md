# Operator foreground scheduling

## Cause and bounded evidence

Base: `ef854bf` (committed main merge, independent of the dirty reconciliation
checkout and the frozen parent-result-authority candidate).

`src/harness.ts` previously excluded a current `host` input from both steer and
interrupt handling in `handle`; `pump` selected `queue[0]`. Thus a direct question
could neither reach a long-running result turn nor pass queued result/wait turns.
A second lifecycle gap kept `s.prompting` true through `afterTurn`: an operator
input arriving after generation could be steered into an idle runtime and then
consumed with an already computed reply. Neither is a Dispatcher worker wait.
`src/dispatcher.ts:55-58` awaits scheduling; `schedule` launches `run` without
awaiting worker completion. `flushEvents` awaits durable host acceptance, not a
Main model reply.

Regression evidence uses synthetic local sessions; private transcript identifiers are not distributed.

## Chosen boundary

* Queued channel/API inputs have stable FIFO priority over host, heartbeat,
  cron, loop and goal inputs, including restored inboxes. Durability gates still
  apply before execution. Completed outbox entries retain their delivery order.
* A channel input during a background prompt uses the existing durable steering
  handoff in **all three** busy modes. Background interrupt is deliberately a
  safe steering request, not an abort. Runtime/tool work reaches its next steering
  boundary; there is no concurrent prompt, tool replay or child cancellation.
* Result `current`, `hostEvent`, execution identity and continuation checks remain
  unchanged. Steering is not a new operator mandate for host-result tool guards.
  This does not implement the separate parent-result-authority fix.
* A question after generation queues for its own turn, instead of being silently
  attached to an already computed reply. Final replies to background steers use
  the question's destination/progress ID, not the old result progress reference.
* API inputs always queue as separate turns, retaining foreground FIFO priority.
  No input steers into or interrupts a current API turn. A run owns its prompt,
  per-turn overrides, progress and terminal delivery; sharing one generated answer
  across independent runs would fabricate completion. API requests can therefore
  wait for the current safe turn boundary, even in steer/interrupt mode.
* Explicit stop/cancel retains the existing command/host cancellation path. A
  normal question never calls `stopConversation`, `onStop`, or `cancelParent`.

Abort-and-requeue was rejected: an interrupted tool-bearing result can already
have performed external effects. Repeating its prompt is not an idempotency
contract. Steering retains the original turn and consumes its durable operator
inputs only at completion. Pending snapshots retain both on a crash; restored
foreground priority is tested. Existing execution-ledger settlement remains the
protection for *completed* turns; this patch does not invent exactly-once crash
recovery for arbitrary in-flight external effects.

## Tests and limitations

`test/operator-responsiveness.test.ts` holds a real Dispatcher strategy running
while Main processes a held host turn. Queue/steer/interrupt each assert durable
injection, preserved provenance, one active prompt, no abort, direct-answer-first
output, distinct progress reference, single completed side effect/result and
subsequent worker-result processing. Restored snapshot ordering and failed-steer
fallback are covered. `test/operator-reply-lifecycle.test.ts` holds `afterTurn`
and proves questions are not consumed by stale output in all three modes.
Updated host test replaces the previous deliberate exclusion expectation.

148 targeted tests and all 511 tests in `test/*.test.ts` passed, including
Harness, Dispatcher host/runtime/scheduler, PI adapter and Matrix tests.
TypeScript build passed; no generated plugin source
changed. Existing Matrix telemetry/final ordering is retained; no live Matrix
round trip was performed.

**Limits:** This is cooperative preemption, not a hard latency SLA. An opaque
long-running tool, provider request, review/maintenance hook or blocked outbox
transport can still delay an answer until its safe boundary. A runtime rejecting
steering falls back to priority queueing, not unsafe abortion. A model can still
answer poorly or continue tools after reading the question; the fake tests prove
coordination, not LLM compliance. Multiple steered questions share the existing
single-turn answer semantics for channels only, never API runs. The review's
F2 runtime-finalization steering window and F3 cross-address channel routing remain
nonblocking P2 limitations; ending `prompting` before `afterTurn` does not close
PI's earlier checkpoint/restoration window. API separation removes API participation
in either problem, not the general channel risks. No broad routing/window rewrite
is included in the P1 correction. Heavy continuous foreground traffic can starve
background work. No exactly-once guarantee is added across a crash during an
unsettled arbitrary tool effect. These limits need explicit independent review;
do not describe this patch as universal immediate interruption.

Review tool status was read only: it reports an existing escalated review of a
different root changeset, three rounds, zero open blockers. It was not reset or
rerun against the dirty parent checkout. Independent review of this isolated
candidate is to be arranged by the parent operator as requested.
