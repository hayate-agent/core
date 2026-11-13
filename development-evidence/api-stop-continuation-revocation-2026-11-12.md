# API stop must revoke retained continuation

## Live finding

During #372 verification, API run `run_68337110596742568f7aaf4d6313b2a9` was stopped at Unix time 1794508118. Its API receipt became cancelled, but its retained Main task remained active. The session then received an autonomous recovery continuation at 18:29:00 UTC and submitted two workers after cancellation. Their timed read-only commands overlapped by 22.765 seconds, but this is NOT accepted as a clean validation because the parent had been stopped. No effects are replayed or records removed to manufacture a result.

## Repair

- Running and queued API cancellation durably stops the exact retained task, clears only its productive admission/retry, and stops its exact durable turn identities before runtime interruption.
- A queued occurrence without a task yet acquires a stopped identity; a restart cannot freshly authorize it.
- Pending local cancellation fences prevent a queued input from executing during failed/retried saves. Followup identities remain available until their turn revocations commit. Final checkpoint failure restores queue identities for normal endpoint retry, without publishing a cancellation delivery prematurely.
- Other accepted runs sharing the same conversation are preserved.
- Known Dispatcher children are revoked by exact task binding, retaining their uncertain intents, checkpoints and completed effects. Their active workers are then interrupted normally.
- Subagents capture host parent-task identity and use it for scoped revocation. Unknown legacy subagent/Dispatcher ancestry is held durably for explicit reconciliation, not guessed or blindly cancelled. Existing host evidence that an unscoped Dispatcher execution predates this task exempts it from the ambiguity hold.
- Startup reconciles persisted stopped tasks BEFORE worker-owner startup, completing a crash between Main stop persistence and child revocation.
- Exact authenticated host API cancellation receipts repair old retained API tasks affected by the previous bug. This does not infer operator stops from assistant text or change arbitrary historical blocked tasks.

## Verification

`test/cancel-recovery.test.ts` reproduces the original active-task-after-stop bug, timer/restart behavior, scoped sibling preservation, save-failure retry, queued cancellation retry, retained followup turn revocation, legacy ownership holds, exact receipt migration and crash-gap child revocation. Existing stop, API, subagent and tool-guard tests remain covered by the full CI suite.

Persistent external evidence: `cancel-recovery-baseline.log`, `parallel-pr372-final-executions.json`, `parallel-pr372-live-outcome.json`. Native activation and a new, uncancelled live parallel timing probe follow green CI/review; the old cancelled run is not relabelled as a clean success.
