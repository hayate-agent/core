# Core operator task lifecycle — first implementation

Date: 2026-11-14. Worktree `.worktrees/repeated-validator-context`, branch `fix/repeated-validator-context`.

## Scope

Addresses the live Odo/Peter root causes plus the clarified Core architecture.
No Pi-extension repository is modified and no installed agent/tasks are changed.

- `src/task-lifecycle.ts`: pure Core state transitions for agent-wide orders, operator disposition versus technical result, revisions/generations, exact ingress sources, original request, optional research/skill-aware plan, durable receipts, explicit inactivity policy and stable plan rendering.
- Existing `ExecutionStore`: owns that task book within its existing atomic commit and home lock. Turn outcomes, plan changes and outbox settlement share the same durable transaction. No separate scheduler, central background judge or second independently authoritative file.
- Harness: fresh accepted operator/scheduled inputs receive bindings; historical unknown tasks migrate held, not automatically open. Admission, recovery, turn/tool execution, wait ticks, child results and technical projections respect disposition/generation. Late closed-order results deliver retained evidence without another working/model-judge turn.
- Main Core surface `plugin_tasks` / authenticated `/orders`: inspect, explicitly finish/reopen, natural-language operator-backed clarification, outcome-bound plan proposals. A thin host API module, not a Dispatcher strategy or optional authority plugin. `/tasks` keeps its existing sessions alias.
- Plan presentation: normal Main-thread checklist derived from the same committed record. Failed/cancelled turns discard proposals. Scoped completion context includes the order/plan rather than all historical topics.
- Dispatcher/subagent execution preserves original task generation and is fenced at tool/turn boundaries. Production execution store refuses missing Core authority. SDK fixtures opt in explicitly.
- Existing no-progress bypass removed: bare validator `continue` is permission, not progress. Dispatcher/control metadata do not reset stagnation. Real explicit analysis milestones and substantive outcomes retain their progress semantics.
- Completed technical parent no longer reopens on a child result. Completion while children are actually running/queued retains waiting; an independently assessed end can coexist with retained blocked child evidence.

## Verification

- Three baseline regression tests failed on unchanged Core: tool-free repeated validation, changing Dispatcher metadata counted as progress, late results reopening a formally completed current parent.
- Final candidate typecheck PASS, build PASS, `git diff --check` PASS.
- Final rebased/reviewed full suite: 2,534 tests; 2,533 passed, 0 failed, 1 skipped. Command: `HAYATE_TEST_CONCURRENCY=4 node scripts/test.mjs`. Log: `/tmp/task-ledger-final-full.log`.
- Separate child Pi review ran without extensions, session persistence, mutations or execution tools. Five specific findings were fixed: command versus in-turn identity, authentic accepting-input provenance, oversized authority fallback, receipt-capacity archival, and presentation inside serialized outcome commit. Targeted rereview resolved four immediately and the remaining ingress finding after the real command-dispatch fix. Review files: `/tmp/hayate-core-task-lifecycle-independent-review.txt`, `/tmp/hayate-core-task-lifecycle-rereview.txt`, `/tmp/task-ledger-command-review.txt`. This is a separate model review, not human or cross-provider approval.
- Added regressions for all five findings, including real command dispatch rejecting synthetic channel-labelled calls, 512-receipt closure with durable original archival, and a queued close winning over plan settlement. An intermediate unchanged Peter fixture hit its known ENOTEMPTY cleanup race; its isolated rerun and final full run passed.
- Added focused tests for done-but-blocked operator disposition, exact new generation, old binding retention, immutable request/clarifications, outcome-justified research/skill todos, inactivity not renewed by tool work, scheduled exemption, held legacy migration, session-independent close/reopen, atomic task/turn settlement, late outcomes, Main-thread plan rendering, no plan adoption on failed work, command idempotence without any model, child tools fenced on closure and simple direct work without Dispatcher/plan.
- Existing process-level CLI/restart tests verify production startup remains usable; genuinely open persisted orders have explicit Core bindings, unbound historical tasks no longer launch their validator during startup.

## Research and skill check

Memory/research used the prior local audit, immutable source history and scoped live metadata/transcript comparisons. The only repository-local skill is `.agents/skills/web-search/SKILL.md`, which is a search-tool usage guide, not task lifecycle policy. No change to that skill is justified. This change needs product documentation and regression tests, supplied here; no agent persona or installed operational skill was silently rewritten. The lifecycle protocol and task tool descriptions explicitly cover skill research, final skill check and justified skill-change outcomes.

## Remaining before broad release/activation

This is a review candidate, not installed acceptance or full fulfillment of every future integration:

- automatic validator-originated plan-patch protocol, beyond the current plan-aware validation and Main-submitted checked proposal;
- registered recurring-series reopen contracts and exact operator-configured inactivity policy; there is intentionally no invented default timeout;
- operator-visible migration inventory/disposition review for Odo/Peter before adopting held legacy tasks; no bulk re-enrollment;
- hosted CI and normal protected-branch integration of the reviewed candidate; no live installed acceptance yet;
- coordination of a versioned host-independent contract with the parallel Pi-extension session, without coupling Hayate's mandatory Core gates to an optional Pi extension.

The passing tests prove the stated candidate behaviors, not that all model-generated semantic associations will be correct or that any live provider has adopted these changes.
