# Bounded retained-task reconciliation — implementation handoff

## Candidate and authority

- Candidate: `/home/node/work/continuity-bounded-reconciliation`
- Branch: `fix/continuity-bounded-reconciliation`
- Base: `ad3c3ef957e00efec9941e0378a2f44d0116fa8c`, freshly verified against remote Main before work and again after tests.
- Dedicated identity: Severus Snape <severus-snape@vanillacore.net>.
- Foreign dirty `/home/node/work/core` was not edited. Separate unchanged baseline: `/home/node/work/continuity-bounded-baseline`.
- PR158 / 0.1.107 is already delivered/activated; not replayed. No push, PR, merge, deployment, restart, nested delegation or formal review run. Read-only plugin_review status showed the foreign changeset's existing history, not candidate review. Owner must review this exact candidate with installed ReviewService and existing home/history before delivery.

## Demonstrated gap and minimal repair

Read packaged development guide fully and relevant task recovery, completion check, context maintenance and self-development docs. Inspected CLI completionCheck: assessCompletion deliberately returns undefined on provider failure, invalid/inconclusive or completed output; that output is advisory, not revocation. Inspected handover/compaction: they rotate/compact runtime context while host task snapshots retain authority.

Baseline `/tmp/bounded-baseline.log`: real tick/drain with an accepted active missing-next task and one thrown provider failure immediately changes state to blocked, contradicting the desired transient recovery (expected active). Likewise undefined result. Interrupted one-shot claim cannot progress after restore. No production provider calls required for reproduction.

Only production change: DurableTask recoveryRetry {attempts,nextAt} plus bounded assessment handling in assessRetainedTask. Persist claim/attempt before inference, at most three attempts, 60-second minimum spacing saved across restart. Interrupted claim consumes one attempt, not authority. Undefined/throw leaves authorized task active until exhaustion. No next step means no execution. After exhaustion use existing persisted one-shot recovery attention/outbox and block. Successful decision uses existing stable recoveryAdmission and inbox barriers, not a new scheduler/service.

Existing authority identity snapshot, pre/post async revalidation, per-session assessment fence, task/depth admission ID and execution revocation guards remain in force. Retry budget is not productive depth or review budget. Reset assessment metadata only at an actual completed productive turn, alongside existing assessment reset. No history export, external observer, historical task migration, automatic blocked/stopped/completed/waiting revival or dependency bypass. Legacy interrupted claims without metadata still escalate, rather than inventing authority.

## Verification

- `/tmp/bounded-focused-final.log`: 78/78 pass. Actual Harness tick/drain, persisted JSON snapshot/restore, transient throw recovery, inconclusive exhaustion across five instances with one delivered escalation, interrupted claim retaining attempt budget, admission/completion restart dedup, real handover and admitted idle compaction followed by restored progression, missing checkpoint, pending dependency, pause/stop/expiry, stale original/anchor/depth, new operator queue and concurrent calls. Async persistence and provider boundaries both fenced. Failed disk claim does not invoke provider or execute. Proposal/history-only text cannot authorize work. Fake effect fixture begins with completed deployment and verifies without repeating it; no exactly-once promise for arbitrary external tools.
- `/tmp/bounded-lifecycle.log`: 64/64 pass (context-*, manual-handover, compaction*). Includes runtime/provider recovery and maintenance lifecycle guards.
- `/tmp/bounded-typecheck.log`: npm run typecheck PASS.
- `/tmp/bounded-build.log`: npm run build PASS, including pinned plugin materialization.
- git diff --check PASS.
- `/tmp/bounded-full.log`: npm test stopped at 240-second command limit; 684 observed passing test lines and two failures, no aggregate completion/PASS claimed. These failures independently reproduce on unchanged exact base after plugin materialization, `/tmp/bounded-baseline-flakes.log`: cron-follow-through reads missing prompts; dedicated-review-integration expects passed but sees pending. Initial unmaterialized baseline probe failed module resolution; rerun after materialization is the relevant evidence. No baseline issue repaired or used to hide candidate failures.

Commands: `node --import tsx --test test/*continu*.test.ts test/*completion*.test.ts test/*recovery*.test.ts test/task-recovery.test.ts test/task-waits.test.ts test/context-maintenance.test.ts test/handover-seed-recovery.test.ts`; `node --import tsx --test test/context-*.test.ts test/manual-handover.test.ts test/compaction*.test.ts`; `npm run typecheck`; `npm run build`.

## Owner next step / limits

Review exact clean commit/tree (reported with git rev-parse in return and external evidence copy). No formal review budget consumed here. Owner alone handles protected delivery and scheduled own activation. Source/tests do not activate running software. Assessment cancellation is fail-closed via before/after authority checks; existing CLI classifier timeout bounds its provider call. Arbitrary providers outside that contract can still hang, unchanged by this patch. Completed external effects still require actual-state reconciliation; arbitrary tool effects do not become exactly-once through advisory classification.
