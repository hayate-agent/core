import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
const mandate = "Implement the fix, publish its PR, then integrate and deliver through normal CI/GitOps";

for (const failure of ["undefined", "error"] as const) test(`inconclusive ${failure} assessment of model-blocked PR retains durable recovery, not a terminal stop`, async () => {
  let checks = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => {
    h.planContinuation(key, { state: "blocked", next: "PR published; awaiting merge" });
    return "PR published, integration still outstanding";
  }), tickMs: 60000, completionCheck: async () => {
    checks++;
    if (failure === "error") throw Error("provider unavailable");
    return undefined;
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  let snapshot;
  try {
    await h.submit(msg(mandate)); await h.drained();
    snapshot = h.snapshotSessions();
    const task = snapshot[0].tasks![0];
    assert.equal(task.state, "active");
    assert.equal(task.explicitBlocked, false);
    assert.equal(task.next, undefined, "the model's alleged blocker is not executable recovery authority");
    assert.ok(checks >= 1);
  } finally { await h.stop(0); }
  let restoredChecks = 0;
  const runtime = new FakeRuntime();
  const restored = new Harness({ runtime, tickMs: 60000,
    now: () => Math.max(Date.now(), snapshot![0].tasks![0].recoveryRetry?.nextAt ?? 0),
    completionCheck: async input => {
    restoredChecks++;
    assert.equal(input.completionAnchor?.task, mandate);
    return { state: "continue", next: "Verify the candidate's required CI before authorized integration" };
  } });
  restored.addChannel(new MemoryChannel()); restored.onStateChange = async () => {};
  try {
    restored.restoreSessions(snapshot!); await restored.recoverTasks();
    assert.equal(restoredChecks, 1);
    assert.equal(runtime.sessions.size, 0, "recovery checkpoints work before releasing execution");
    assert.equal(restored.pendingInputs().length, 1);
  } finally { await restored.stop(0); }
});

test("independent completion corrects a model-blocked publication-only goal without replaying work", async () => {
  let checks = 0;
  const runtime = new FakeRuntime(() => {
    h.planContinuation(key, { state: "blocked", next: "PR published; merge requires separate authority" });
    return "The requested open PR is published";
  });
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => {
    checks++; return { state: "completed" };
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Publish one reviewed PR; do not merge or deploy")); await h.drained();
    assert.equal(h.snapshotSessions()[0].tasks![0].state, "completed");
    await h.recoverTasks(); await h.tick(); await h.drained();
    assert.equal(checks, 1);
    assert.equal(runtime.sessions.get(key)!.prompts.length, 1);
  } finally { await h.stop(0); }
});
