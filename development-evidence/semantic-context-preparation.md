# Semantic continuation context prerequisite

## Finding

Automatic maintenance does not guarantee relief before semantic WAIT override.
Harness post-turn maintenance runs before completion assessment; pre-turn automatic
handover requires known usage, enabled autoHandover, cooldown and semantic
eligibility. Unknown usage deliberately disables threshold inference. The completion
parser previously discarded any preparation indication. The pinned completion
prompt does not ask the checker to identify context exhaustion or emit a preparation
field. Native PI overflow is a fallback, not proof of prerequisite completion.

## Core contract added

A `continue` verdict may include `contextPreparation: "compact" | "handover"`.
Invalid preparation values invalidate the executable verdict. The prerequisite is
persisted on the queued input and retained task and executed before the next working
prompt through ContextMaintenance's existing boundary implementation. Compaction
uses the after-boundary action without incrementing completed turns; handover uses
existing archive/summary/rotation/seed/link recovery. Failure holds working prompts,
including subsequent attempts/restarts, with the existing recovery retry pacing.
Automatic maintenance disable and autoHandover disable remain binding; no forced
maintenance is added to plain continuation. Existing cancellation, dependency,
authority and productive-budget checks remain in place.

## Required separately owned prompt change (NOT delivered here)

Repository: https://git.vanillacore.net/harness/plugins
Pinned revision: 1600a618e6284c3274ceb95f5d92ba28cd08b8aa
Origin file: src/completion-prompt.ts
Current SHA256 in plugins.lock.json:
29ca66c495da1270d9c5bbb096bfa36e3629e49f5744b22dab0412baeb485dcd
Materialization: scripts/materialize-plugins.mjs fetches
<repository>/raw/commit/<revision>/src/<name>, verifies SHA256 and rewrites relative
imports into generated src/builtin-plugins. Do not edit generated files.

Minimal proposed source change: extend JSON schema with optional
`contextPreparation: "compact" | "handover"`. Instruct the checker to distinguish
context exhaustion from a genuine external/permission/security hold; when a safe
step remains in the original mandate but context relief is necessary first, return
continue + the concrete safe next step + the required preparation. Choose compact
for in-session relief or handover for checkpoint-resumable work requiring a fresh
session. Do not request maintenance for every continuation, invent usage percentages,
relax real holds or claim that preparation itself grants authority. Existing DATA
contains bounded recent evidence and reply; no new token percentage is fabricated.

Parent must implement/review/test that source change, then update immutable revision
and all corresponding plugin hashes in core plugins.lock.json and rematerialize.
Until then stock production prompting is NOT guaranteed to emit this new field.
Core integration tests use the stock prompt with scripted reviewer JSON; they prove
host execution/ordering, not live classifier recognition or a deployed runtime.

## Regression evidence

Initial new integration test: four failures, one pass. Both relief actions were
missing before work-2; both failure fixtures incorrectly executed work-2. The plain
continue negative control passed. After correction all five integration cases pass.

Tests assert exact work-1 -> checker -> compact -> work-2 or work-1 -> checker ->
summary -> seed -> work-2 order; mandate/no-deployment preservation; archive ID and
old/new session linkage; no working prompt on preparation failure; durable pending
prerequisite and restart fail-closed behavior; no maintenance on plain continuation.
Additional parser/policy tests cover valid compact/handover, invalid/null values,
and disabled automatic/handover policy without runtime side effects.

Focused suite command:
node --import tsx --test test/semantic-context-preparation.test.ts test/completion-context-preparation.test.ts test/semantic-turn-continuation.test.ts test/completion-check.test.ts test/context-*.test.ts test/handover-seed-recovery.test.ts test/manual-handover.test.ts test/harness.test.ts

Owner-run checks on macOS: 148/148 focused tests pass; npm run typecheck and npm run
build pass. No live provider acceptance, cross-family independent review, push,
merge or deployment performed by this executor.

Full-suite check: initial default macOS temp path produced canonical-path fixture
failures. Re-run with TMPDIR=/Users/karsten/.hermes/cache/scratch: 1,051 tests,
1,042 passed, 3 failed, 3 cancelled, 3 skipped. Remaining failures: two unavailable
LocalMemory worker tests and task-waits' pre-existing assertion that a checker
continue must retain WAIT (contradicts the commissioned fix). Three observer tests
cancel with an unresolved promise/event-loop exit. Exact base 7dcec74 exported to
isolated scratch and rerun against the four affected test files reproduced the same
3 failures and 3 cancellations (28 tests, 22 passed). No tests were weakened or
modified to hide those baseline failures. Logs: scratch/semantic-context-tests.log,
semantic-context-full-tests.log, semantic-context-canonical-tests.log,
semantic-context-base-tests.log under /Users/karsten/.hermes/cache/.
