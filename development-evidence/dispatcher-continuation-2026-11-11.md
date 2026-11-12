# Dispatcher continuation and technical worker recovery

## Incident evidence

Read-only local inspection found the quoted 147-test reply at 2026-11-11
05:16:48 UTC. It was followed by an actual wait recheck at 05:19:03, so this
was not proof that the validator never ran. Persisted parent decisions included
`proposal: waiting, verdict: continue`, but child gating suppressed admitted
parent work. Polling windows were inherited into task expiry. The affected
local task had only 3 stalled repetitions, not an exhausted 20-attempt budget.
A publisher was running with dispatcher capacity 1 while its review remained
ready. A separate current Randy task retained the quoted EOF/Main-takeover
reply and was classified completed; the Main tool path had no implementation
routing guard.

## Fix

- Keep model polling windows separate from authentic task expiry.
- Retain read-only parent monitoring while a running child owns the work, even
  across the initial polling deadline. Never renew authentic task authority.
- Atomically requeue typed technical worker failures through the dispatcher,
  retaining the same execution ID, latest failed worker transcript, intent and
  original mandate. Persist exponential backoff; no lifetime retry cutoff.
- Preserve manual pause, cancellation, unanswered questions, actual expiry,
  unavailable reconciliation strategy and trusted recovery-policy holds.
- Guard native Main shell/file mutation and standalone-subagent start while
  the dispatcher is enabled and ready. Main retains read/search/orchestration.
- Yield at committed sequential-step boundaries with round-robin admission,
  allowing queued reviews to acquire capacity without preempting active tools.
- Tell the completion assessor that saved read-only corrections are not a
  permanent restriction on the original task; expose scheduled retry status.

## Verification

Integrated protected main `51cb8ed` normally, preserving the independently
landed parent-decision revision fencing. Companion plugins PR #83 includes
normal integration of plugins main `95e1962`; core pins immutable plugin commit
`3f5b95c7bbce5580cc3aa393e72b543d6c2b2b59` and verifies source hashes.

- Core build/typecheck: passed.
- Full integrated core suite: **1,831 tests, 1,830 passed, 0 failed, 1 skipped**.
- Full companion plugin suite against integrated core: **84 passed, 0 failed**.
- Independent model review of the supplied diff found and drove fixes for:
  expired polling monitors, most-recent retry transcript, and authentic expiry
  during retry backoff. Final supplied-diff review: no concrete P1/P2 findings.
  This was a diff review, not a separate checkout/test execution by the reviewer.
- Existing cleanup-hook race was corrected by stopping the fixture dispatcher
  before removing its ledger directory.

Reproduction coverage includes retained monitor on the real Harness path,
actual same-ID Dispatcher recovery across reload, repeated-failure transcript
selection, manual/cancel/policy/expiry holds, capacity-1 fairness and Main guard
fallback only when dispatcher availability is false.

## Deliberate boundaries

No live ledgers were modified, historical expiries were cleared, workers were
cancelled or services restarted by this source change. Historical task expiry
provenance remains ambiguous and requires separate reconciliation rather than
blanket revival. A busy dispatcher is not a broken dispatcher. No preemption
of an in-flight worker is introduced; fairness acts at durable step boundaries.
Generic strategy exceptions are not automatically called transient from prose.
Publication/CI is distinct from release activation and fleet verification.
