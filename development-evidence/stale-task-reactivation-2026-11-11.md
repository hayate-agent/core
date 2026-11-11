# Historical task reactivation: source and read-only live investigation

## Baseline and scope

New worktree `.worktrees/stale-task-reactivation`, branch
`fix/stale-task-reactivation`, from fetched Core main `33efc9b`.
Initial investigation was read-only. After the operator requested delivery, the
candidate was extended with the explicit historical-recovery upgrade boundary
below and prepared for normal PR/release/owner rollout. No live state-file edits
are part of the repair; the reviewed runtime owns its durable migration.

Read-only persisted metadata snapshots collected around 2026-11-11 07:39 UTC
from Shikamaru, Peter at the **correct native Linux 192.168.1.103**, Akira,
native Karsten and six Kubernetes agent installations. The inspected installed
metadata generally identified 0.1.229 / `057cc37`. Code main additionally contains
plugin lock/settings changes through `33efc9b`.

## Measured state (snapshot, not a claimed immutable live status)

| Agent | Nonterminal tasks >1 day | Among these active | Among these with saved recovery admission |
|---|---:|---:|---:|
| Peter .103 | 197 | 72 | 46 |
| Akira | 174 | 14 | 1 |
| Randy | 143 | 5 | 0 |
| Shikamaru | 9 | 3 | 0 |
| Minato | 21 | 14 | 0 |
| Che | 20 | 0 | 0 |

An active flag/admission is not by itself proof that a tool already executed.
These counts distinguish retained history from actual authorization to re-enter.
No claim is made that every old task or every agent followed the same path.
The ordinary fleet channel advanced during analysis: final audit target was
0.1.231 / `33efc9b`; Che/Randy/Minato reported that newer source, while Peter .103
and Shikamaru still reported 0.1.229. No part of this investigation initiated
those normal owner rollouts. The documented source paths remain present in the
fetched current-main baseline.

Peter had six unfinished executions without dependency.taskId. **43 historical
parent admissions shared one identical dependency snapshot hash**, with anchors
4.58–8.10 days old and separately model-generated next steps. This is a direct
signature of an unknown child set being treated as a possible dependency of
multiple historical tasks. Akira had five unscoped paused runtime-failure workers
(including old night work) and a saved independent admission for a 5.71-day-old
parent. Shikamaru also had an unscoped paused runtime-failure worker.

Private snapshots, containing bounded task excerpts, are intentionally not copied
into Git: `~/.cache/hayate-maintenance/stale-task-reactivation/`.

## Deterministic chain behind the observed fan-out

1. Every channel ingress creates/retains a DurableTask. `tasks` is historical and
   independent of the most recent `task` compatibility pointer. A later question
   does not supersede earlier tasks automatically.
2. An unresolved completion check can retain the task as active with retry state.
   This prevents legitimate dropped work, but leaves substantial historical debt
   where the human considers the outcome finished and the ledger does not.
3. `recoverTasks`, idle ticks and between-turn boundaries revisit those tasks.
   There is no explicit lifecycle distinction between historical unresolved work
   and currently enrolled autonomous work. There is no default mandate expiry.
4. `mayDependOn` treats a worker without taskId as a possible child of every task
   that did not durably record it as preexisting. This is conservative as a BLOCKER.
5. `reconcileBlockedDependency` nevertheless sent these ambiguous children to the
   model and allowed a continue verdict to set the historical parent active and
   mint a persistent independent admission. The old `hasPendingDependency` then
   accepted the admission despite missing task provenance, using a matching hash.
   Consequently one old child set can seed admissions for many old parent tasks.
6. Topic foreground priority only postpones certain tagged independent admissions
   while a newer disjoint topic is open. Once that newer topic is not active,
   older admissions become runnable again. Untagged tasks never receive this
   deferral. Thus a newer task completing can expose a long backlog.

The independent legacy-parent behavior is not new in #330. It was intentionally
introduced in `fd57e02` (2026-11-04). Existing tests explicitly required it. The
context-isolation change in #330 removed resultMandate's current-focus fallback,
but did not close this separate supervisor admission path.

## Recent amplifier: polling lifetime changed in #331

`f87ad63`, merged in Core #331 (`057cc37`), changed wait handling:

- An elapsed wait.deadline is now a polling-window end, not necessarily a mandate
  deadline. It is no longer inherited in several continuation transitions.
- With a running child the monitor can renew its nonproductive polling window.
- Without such a child, an elapsed wait with no task.expiresAt becomes active;
  its wait and retry markers are cleared for a subsequent independent assessment.
- The change applies to persisted legacy waits too: they have no schema marker
  distinguishing their former bounded-window semantics from newly created polls.

A characterization regression demonstrates this transition without inference:
an eight-day-old waiting task with a seven-day-expired wait and no task.expiresAt
becomes active on tick. This is NOT fixed by the provenance patch below.

Real task.expiresAt remains binding. Do not call every wait deadline an operator
expiry, and do not "fix" this by expiring arbitrary old tasks or cancelling workers.

## Fix candidate implemented here

Unknown ownership remains a blocker, never an autonomous authority source:

- Before independent dependency inference, any relevant unscoped worker causes
  the existing durable unknown-effects blocker; no model call/admission.
- A stored independent admission can bypass pending dependencies only when every
  child has exact matching taskId AND original mandate. A matching snapshot hash
  does not establish identity.
- The blocker clears stored ambiguous admission while retaining parent/worker
  evidence. Workers are not claimed, resumed, cancelled or edited.
- Exactly scoped independent work and new tasks with a captured preexisting set
  remain supported. The patch does not disable productive assessment globally.

Two initial negative regressions failed on unmodified current main: unknown
child admits old work, and saved unknown-child admission survives restart. The
same cases pass with the patch. Positive tests preserve scoped recovery and
fence one parent's child from another historical task.

Several old tests intentionally asserted the now-rejected legacy admission; they
were changed to require deterministic blocking, no inference and no worker replay.
A preliminary experiment gating all model-blocked tasks was removed: the
`explicitBlocked` flag is model state, not an operator stop, and conflating those
would break legitimate scoped independent work.

## Initial open questions, addressed for delivery

The initial provenance-only patch left these lifecycle questions open:

- Explicit host-owned enrollment/suspension of autonomous recovery is needed to
  distinguish current open work from legacy unresolved history, with exact-task
  operator re-enrollment and retained read-only evidence. Age and model guesses
  alone must not grant or revoke authority.
- Polling-window vs mandate-lifetime semantics need a persisted version/intent
  marker and a conservative legacy migration policy; do not silently reinterpret
  an old saved bounded wait as an indefinite mandate.
- A future activation must account for already queued/admitted stale inputs and
  decide their non-executing retention behavior, not just prevent new admissions.
  This candidate fences ambiguous admissions at execution checks, but does not
  claim a reviewed fleet-wide data migration or harmless re-entry projection.
- Do not delete old ledgers, globally cancel tasks, reset budgets, stretch
  deadlines or fabricate completion to hide the symptom.

## Completed delivery boundary

See `docs/historical-recovery-boundary.md`. `holdLegacyRecovery` runs after state
load and before restored input release, and its results are saved before any
plugins/channels/dispatcher can start. Historical unresolved tasks are held unless
an exact ongoing worker or authentic interrupted ingress proves ongoing work.
New tasks carry current enrollment. Held generated queue entries are retained
separately, not replayed; elapsed polls hold rather than re-enroll. All autonomous
assessment/queue/task-selection/result-continuation paths honor the hold.
Authenticated `/task-resume <task-id>` enables one held task for fresh assessment,
never archive replay, budget reset, expiry extension or operator-stop override.

## Validation

- Final full suite with upgrade boundary and explicit resume regressions:
  **1848 passed / one optional skip / zero failures**.
- Typecheck and diff-check passed.
- No live mutation or rollout. These findings are source/state correlation plus
  synthetic causal reproduction, not complete historical execution tracing of
  every agent's reported incident.
