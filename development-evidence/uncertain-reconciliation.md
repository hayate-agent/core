# Uncertain completion reconciliation — local implementation

## Scope and source

- Packaged `/opt/vanillacore-harness/docs/development.md` read before changes.
- Remote verified with `git ls-remote` and fetch: main `51304b5e832a32b6893a6815460a0981a9846f53`; PR196/head and branch fix/recovery-failed-only-warning `91d9f7c5175d852e7e92fdfef9269f0a7745a7a5`.
- Dedicated initially clean worktree `/home/node/work/reconcile-uncertain-completion`, branch `fix/reconcile-uncertain-completion`, based on main. PR196 is not merged and not used as base: its passive retention interpretation is being replaced, not stacked.
- Dirty `/home/node/work/core` left untouched; before/after status paths identical. No push, PR mutation, merge, deployment, or productive external effects performed.

## Behavioral contract

An inconclusive/unavailable completion verdict alone is neither completion nor a substantive blocker. For eligible active authorized work, retain an existing next step or persist an evidence-reconciliation next step, using the existing runnable-task admission/barrier and original identity/deadline. That working turn must inspect actual state/last answer/execution evidence before any necessary effects, retain completed facts, stop on supported completion/no necessary next move, or perform/queue an authorized safe next step. It must not only re-run the evaluator. A completed/stopped durable task is not reopened merely because assessment is absent. Working continuation turns can settle their own explicit completion/blocker without requiring a usable classifier verdict; unsupported initial-turn terminal claims remain subject to reconciliation.

No new persisted state machine or schema. Existing pause/stop/dependency/deadline/ownership/persistence guards remain. Interrupted/invalid admissions and bounded technical failures still surface through existing recovery attention. Consecutive unevidenced working attempts without a plan now also enter the existing 20-attempt budget guard (previously only explicit continue/blocked plans did).

## Changes/tests

`src/harness.ts`: reuse durable next/runnable task queue for reconciliation, preserve stored next on nondecision, prevent stale cancelled admissions from reopening completed tasks, allow explicit terminal settlement in continuation turns, apply repetition limit to unplanned active work. Targeted regression file `test/uncertain-reconciliation.test.ts`: inconclusive/unavailable x stored/no stored next, serialized restart and second restart, no repeated effects, completed Q&A, completed/stopped/paused/expired/budget boundaries, bounded working failures. Existing fixtures now explicitly report completed verification instead of assuming a missing plan means completion; old uncertainty-as-blocker assertions updated.

Verification logs in `development-evidence/uncertain-reconciliation/`:
- typecheck.log: success
- build.log: success
- targeted-final.log: 120/120 pass
- full-final.log: 1135/1135 pass
- `git diff --check`: clean

Dependency setup: initial ambient production-only dependencies lacked tsc/tsx. Installed private worktree dependencies with `npm ci --include=dev`; no source lockfile changes.

## Independent review — NOT satisfied

Called plugin_review status and run. Both returned the original workspace's unrelated fingerprint `cbeaa734eece60e9ea0e688449dec3aa02bb01f0cdf7fa4eb8b5ef1466da9937`, status escalated, 3 rounds, 0 open blockers, findings in `src/execution-recovery.ts` / `src/execution.ts` (not changed here). Evidence path `/home/node/.vanillacore-harness/reviews/de31f07a9573c1d49128a102a8b47fb8d8065658e772533c559507933f027ba4.json`. This is NOT review of this changeset. Tool exposes no cwd parameter. Did not repoint dirty workspace or reset persistent budget. Independent review of this worktree remains required before completion/publication; no claim of P0/P1 clearance for these bytes.

## Superseding PR196 / limitations

After authorized owner review with correctly scoped review infrastructure: replace PR196's patch with this single-purpose branch (or close PR196 and open a replacement); do not merge both. No unrelated night-start changes, no activation requested/performed. This is local implementation only and not live completion.

Semantic reconciliation is performed by the existing working runtime, not a deterministic proof engine: supplied evidence and actual safe inspection must support completion/actions. Tests use controlled runtimes and real Harness persistence/admission paths, not a live provider/deployment. Existing legacy records already marked blocked by PR196 are not blanket-reactivated: doing so without distinguishing genuine blockers would violate preserved boundaries. A failed technical assessor can still exhaust its existing bounded technical recovery guard; semantic uncertainty/unavailability is not charged as technical failure.
