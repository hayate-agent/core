// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { dedicatedReviewBackend, type DedicatedReviewExecution, type ReviewExecutionReceipt } from "../src/builtin-plugins/review-executor.js";

const identity = { cwd: "/isolated/candidate", sessionKey: "parent", fingerprint: "exact-bytes" };
const receipt = (kind: ReviewExecutionReceipt["kind"]): ReviewExecutionReceipt => ({ kind, executionId: "dedicated-review-1", isolated: true, fingerprint: identity.fingerprint, result: '{"findings":[]}' });
const run = (execution?: DedicatedReviewExecution, signal?: AbortSignal) => dedicatedReviewBackend(execution, identity).review("review data", "provider/model", "low", signal);

test("enabled dispatcher always selects dedicated worker, never subagent", async () => {
  let workers = 0;
  assert.equal(await run({ dispatcherEnabled: () => true,
    dispatcherWorker: async request => { workers++; assert.equal(request.fingerprint, identity.fingerprint); return receipt("dispatcher-worker"); },
    subagent: async () => { throw Error("must not select"); } }), '{"findings":[]}');
  assert.equal(workers, 1);
});
test("disabled dispatcher selects dedicated subagent", async () => {
  assert.equal(await run({ dispatcherEnabled: () => false, subagent: async () => receipt("subagent") }), '{"findings":[]}');
});
test("failed primary only falls back to explicit isolated handover worktree", async () => {
  assert.equal(await run({ dispatcherEnabled: () => true,
    dispatcherWorker: async () => { throw Error("unavailable"); },
    subagent: async () => { throw Error("not allowed when dispatcher enabled"); },
    handoverWorktree: async () => receipt("handover-worktree") }), '{"findings":[]}');
});
test("missing dedicated executor fails closed instead of using main-context backend", async () => {
  await assert.rejects(run(), /self-review is forbidden/);
  await assert.rejects(run({ dispatcherEnabled: () => false }), /unavailable/);
});
test("wrong candidate or missing isolation never approves", async () => {
  for (const bad of [{ ...receipt("dispatcher-worker"), fingerprint: "other" }, { ...receipt("dispatcher-worker"), isolated: false }]) {
    await assert.rejects(run({ dispatcherEnabled: () => true, dispatcherWorker: async () => bad as ReviewExecutionReceipt }), /receipt mismatch/);
  }
});
test("cancellation cannot start fallback review", async () => {
  const abort = new AbortController(); let fallback = false;
  await assert.rejects(run({ dispatcherEnabled: () => true,
    dispatcherWorker: async () => { abort.abort(); throw Error("cancel"); },
    handoverWorktree: async () => { fallback = true; return receipt("handover-worktree"); }
  }, abort.signal), /cancelled/);
  assert.equal(fallback, false);
});
