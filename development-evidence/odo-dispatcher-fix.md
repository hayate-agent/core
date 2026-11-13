# Odo Dispatcher fix — implementation and verification

2026-11-13. Base: Core d08da97 (Odo 0.1.300). Branch: fix/odo-dispatcher-loops-and-noise.

## Implemented

- Valid blocked/waiting assessments have separate assessment-blocked/assessment-waiting diagnostics. No technical worker retry is scheduled and no transport retry budget is consumed.
- Startup adopts historical current semantic holds marked runtime-failure or retry-exhausted, preserving intent, checkpoint, settled effects and ownership. No worker replay or automatic release.
- Three consecutive worker corrections without new successful host-observed tool-result receipts stop as assessment-stalled. Retained assessment/unsafe intent remain inspectable; no fabricated completion. Existing independent plan steps remain eligible through the independent readiness selector.
- New parent decision evidence or an explicit authenticated resolution can permit another bounded retained-step correction. The resolution grant is claim-local and cannot reset counters on timer claims.
- Fresh request IDs under the same parent mandate cannot evade a stalled child; exact repeats cannot evade semantic holds. Independent parent mandates remain runnable and request-ID idempotence is preserved.
- Normal chat no longer receives internal dispatcher plans, model choices, validator rounds or step progress. API progress, real questions, actionable blockers and durable result acceptance remain separate and intact. This covers Matrix parents as well as Cron-prefixed parents.
- Parent liveness accepts settled semantic holds without requiring the obsolete transport-retry metadata; it does not release the held child.

## Verification

- npm run typecheck: PASS.
- npm run build: PASS.
- HAYATE_TEST_CONCURRENCY=4 node scripts/test.mjs: 2,386 tests, 2,385 pass, 0 fail, 1 skip, approximately 110 seconds. Full local log: /tmp/odo-full-tests-final.log.
- Focused tests include blocked/waiting restart stability, legacy adoption, no-progress cutoff, independent work, new request-ID bypass, explicit decision/resolution release, >64 legitimately novel receipts, chat/API/result routing, worker retry boundaries and parent liveness.
- Initial full test run lacked the native Matrix crypto artifact because npm policy blocked install scripts. Restored the exact locked 0.4.0 Linux x64 artifact from the existing local checkout and verified SHA-256 7078d4dd987128f79afd192c4f621f64adece37e43f2a8756f1d0a9f034de718 (same as CI).
- One intermediate run hit an unrelated peter-approved-recovery fixture cleanup ENOTEMPTY. Its isolated rerun passed 7/7; the final full run above passed without test exclusions or changes to that fixture.
- git diff --check: PASS.

## Delivery boundary

No installed agent or live task modified. HTTPS push dry-run failed because no Git username/credential is available in this session; SSH Git endpoint port 22 refused connection. Therefore no remote branch/PR/merge/release or Odo rollout is claimed. Local implementation, tests and commit are not installed acceptance.

Existing completed-child/parent continuation cycles are not semantically deduplicated by comparing prose. The new parent-mandate admission gate prevents bypass of a proven stalled child; it does not falsely assume all similarly worded recurring monitoring results are duplicates. Technical inconclusive inference retains its existing read-only backoff policy.
