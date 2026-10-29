import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const state of ["waiting", "blocked", "continue"] as const) {
  test(`independent completed verdict cannot discard explicit ${state} checkpoint`, async () => {
    let turns = 0;
    let h: Harness;
    const runtime = new FakeRuntime((_text, key) => {
      turns++;
      h.planContinuation(key, turns === 1 ? { state, next: "Verify the existing regression" } : { state: "blocked" });
      return "A substep is complete; retained mandate remains.";
    });
    h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => ({ state: "completed" }) });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Implement and test the update")); await h.drained();
      assert.equal(h.state("mem:room1").task?.state, state === "continue" ? "blocked" : state);
      assert.equal(turns, state === "continue" ? 2 : 1);
    } finally { await h.stop(0); }
  });
}

for (const mode of ["inconclusive", "failed"] as const) {
  test(`${mode} assessment never implies completed`, async () => {
    const h = new Harness({ runtime: new FakeRuntime(() => "Work might remain"), tickMs: 60000,
      completionCheck: async () => { if (mode === "failed") throw Error("provider unavailable"); return undefined; } });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Implement and test the update")); await h.drained();
      assert.equal(h.state("mem:room1").task?.state, "active");
      await h.recoverTasks(); h.releaseRestored(); await h.drained();
      assert.equal(h.state("mem:room1").task?.state, "active");
      assert.equal(h.state("mem:room1").task?.recoveryRetry?.attempts, 1);
      assert.equal(h.state("mem:room1").task?.recoveryAttentionId, undefined);
    } finally { await h.stop(0); }
  });
}
