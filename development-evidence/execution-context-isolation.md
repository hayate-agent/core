# Execution-context isolation: analysis and fix candidate

## Scope

Core base: `5628237` (current main and durable parent decisions integrated before release).
Plugin base: `95e1962`; candidate `b7be618` (Plugins PR #84, merged as `59757c9`). Branches: `fix/execution-context-isolation` and
`fix/dispatch-context-assertion` in sibling `execution-context-plugins`.

Source-level investigation of the reported inherited-deadline review failure.
No historical production ledger/log correlation was performed; the quoted
05:30/08:00 incident timeline is not independently verified here. No live
configuration, deadlines, jobs or installed releases were modified.

## Findings

1. `Dispatcher.submit` snapshots `Harness.dependencyCheckpoint(parent)` from the
   current host turn. It does not resolve authority from the model's task prose.
   That is deterministic, but insufficiently explicit at the model API boundary.
   The plugin returned only execution ID/request ID/status, hiding task/deadline.
2. `Harness.resultMandate` explicitly fell back from a missing historical child
   task to `session.task`. Thus an old result could adopt an unrelated current
   mandate. This is a real cross-task fallback, not just a misleading message.
3. `ExecutionStore.submit` deduplicated identical request IDs/input/strategy while
   ignoring parent task ID. Identical text under a newer task could return the
   old execution and its deadline, including from the archive lookup.
4. `dependencyCheckpoint` copied the input deadline instead of taking the tightest
   stored task/wait deadline. Authority should not depend on every ingress having
   copied that field perfectly.
5. Dispatcher strategy errors collapsed to `runtime-failure`; sequential expiry
   used an ordinary Error. Resume did not reject the expired saved deadline before
   scheduling another attempt.

## Candidate changes

- Model dispatcher submissions require `taskId`, checked against the host's active
  task. It is an assertion, NOT a task selector or a grant to change authority.
  Missing/mismatched IDs fail before storing a job. Host-only callers retain the
  existing optional API; scheduled mandates remain host-owned.
- Task IDs plus effective numeric deadlines are returned on admission, status,
  command status and paginated field reads. The host continuation scope exposes
  stored task deadlines and explains the assertion contract.
- Missing/legacy result ancestry fails closed; no current-focus fallback. Exact
  task ID and original mandate must match. The tightest task/wait/child/input
  deadline remains binding.
- Reusing a request ID across task IDs is rejected within the store transaction.
- Dispatcher checks expiry before strategy entry (also after parallel-admission
  waits), persists `deadline-expired`, and emits that cause in its status event.
  Sequential boundary expiry uses a typed host cause. Resume checks the unchanged
  stored deadline atomically and refuses it without scheduling a worker.
- Existing tests that explicitly expected adoption of the current task after
  deleting the original were removed from the positive test matrix. Dedicated
  negative regressions cover missing historical and legacy ancestry instead.

## Guarantee and limits

Task identity and deadline inheritance can be mechanically checked. A wrong
explicit task ID cannot switch the active host mandate. A historical result or
request ID cannot silently adopt a different task.

No host can prove that arbitrary natural-language work semantically belongs to
its mandate merely by checking IDs. A model can still describe unrelated work
while asserting the active ID. Preventing that requires structured, host-owned
work items/allowed operations and/or a separate scope gate. This candidate does
not claim semantic isolation, replace existing approvals/review guards, or audit
all subagent/plugin delegation paths. It specifically hardens dispatcher
admission and result-continuation authority.

Compatibility: older model tool calls without `taskId` are rejected and must be
corrected using the host scope. Legacy results without a retained task are not
auto-continued; they require explicit operator reconciliation/new admission.

## Validation and local reproduction

- TypeScript: `./node_modules/.bin/tsc -p tsconfig.json --noEmit` passed.
- Core: 148/148 focused tests passed (dispatcher, result, explicit continuation,
  task fences, inherited Main wait deadlines, worker mandate).
- Plugins: 9/9 dispatcher tests passed, including two new contract regressions.
- `git diff --check` passed.
- Final full repository suite after main integration: 1815 passed, one optional skip, zero failures.
- Full top-level plugin suite: 85 passed. Native plugin compatibility CI passed.
- Bound admission uses an explicit host capability (`submitBound`); an older
  host rejects the plugin operation instead of ignoring its context assertion.
- Full-suite findings corrected: worker-continuation fixture delegated after the
  owning turn was idle (and depended on the removed fallback); it now delegates
  inside that turn. Fresh-session cleanup now awaits dispatcher shutdown before
  deleting its ledger directory instead of running separate hooks in wrong order.
- Production integration/deployment pending at commit time.

Generated builtin plugins are ignored build output. `plugins.lock.json` now pins
published plugin candidate `b7be618` and exact file hashes. Normal build fetches
and verifies those immutable sources (no development lock override).

```sh
npm run build
npm test
```

Independent plugin tests:

```sh
cd ../execution-context-plugins
node --import ../execution-context-isolation/node_modules/tsx/dist/loader.mjs \
  --test test/dispatcher*.test.mjs
```
