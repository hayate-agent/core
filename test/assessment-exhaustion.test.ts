import test from "node:test";
import assert from "node:assert/strict";
import { Harness, type DurableTask } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
const key = "mem:room1";
const retained = (): DurableTask => ({ id: "authorized", original: "Inspect receipt; never republish", state: "active", depth: 1 });

for (const mode of ["throw", "empty", "invalid"] as const)
test(`${mode}: three bounded assessments yield durable work, not a fourth assessment`, async () => {
  let now = 100, checks = 0;
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, now: () => now,
    completionCheck: async (_i, _r, _s, diagnostic) => {
      checks++;
      if (mode === "throw") throw Error("private diagnostic");
      if (mode === "invalid") diagnostic?.("invalid_response");
      return undefined;
    } });
  h.restoreSessions([{ key, task: retained() }]); h.onStateChange = async () => {};
  try {
    for (let i = 1; i <= 3; i++) {
      await h.recoverTasks();
      assert.equal(checks, i);
      assert.equal(h.state(key).task!.recoveryRetry?.attempts, i);
      if (i < 3) {
        assert.equal(h.state(key).task!.next, undefined);
        await h.recoverTasks(); assert.equal(checks, i, "reserved backoff must not spend another attempt");
      }
      now += 400000;
    }
    assert.equal(h.state(key).task!.state, "active");
    assert.match(h.state(key).task!.next!, /never replay completed effects/);
    await h.recoverTasks(); assert.equal(checks, 3);
    assert.equal(h.pendingInputs().length, 1);
    assert.equal(h.outboxEntries().length, 0);
  } finally { await h.stop(0); }
});

for (const attempts of [1, 3]) test(`unavailable with reserved retry ${attempts} reconciles without waiting for evaluator`, async () => {
  const task = retained(); task.recoveryAssessment = "claimed";
  task.recoveryRetry = { attempts, nextAt: 999999, diagnostic: "technical" };
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, now: () => 100 });
  h.restoreSessions([{ key, task }]); h.onStateChange = async () => {};
  try {
    await h.recoverTasks();
    assert.equal(h.pendingInputs().length, 1);
    assert.equal(h.state(key).task!.recoveryRetry?.diagnostic, "technical");
    assert.equal(h.state(key).task!.state, "active");
  } finally { await h.stop(0); }
});
