import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const state of ["waiting", "blocked", "continue"] as const) {
  test(`independent completion preserves ${state === "continue" ? "productive continue before assessing the next blocked turn" : state === "blocked" ? "authority over model blockage" : "an explicit waiting checkpoint"}`, async () => {
    let turns = 0;
    const assessed: string[] = [];
    let h: Harness;
    const runtime = new FakeRuntime((_text, key) => {
      turns++;
      h.planContinuation(key, turns === 1 ? { state, next: "Verify the existing regression" } : { state: "blocked" });
      return "A substep is complete; retained mandate remains.";
    });
    h = new Harness({ runtime, tickMs: 60000, completionCheck: async input => {
      assessed.push(input.continuation?.state ?? "none");
      return { state: "completed" };
    } });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Implement and test the update")); await h.drained();
      assert.equal(h.state("mem:room1").task?.state, state === "waiting" ? "waiting" : "completed");
      assert.equal(turns, state === "continue" ? 2 : 1);
      assert.deepEqual(assessed, state === "continue" ? ["continue", "blocked"] : [state],
        "completed assessment of productive continue cannot prevent the second turn");
      if (state !== "waiting") {
        await h.recoverTasks(); await h.tick(); await h.drained();
        assert.equal(turns, state === "continue" ? 2 : 1, "completed work is not replayed");
        assert.equal(assessed.length, state === "continue" ? 2 : 1);
      }
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
