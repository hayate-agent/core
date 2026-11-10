import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const state of ["waiting", "blocked", "continue"] as const) {
  test(`independent completion vetoes model ${state}`, async () => {
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
      assert.equal(h.state("mem:room1").task?.state, "completed");
      assert.equal(turns, 1);
      assert.deepEqual(assessed, [state], "a terminal supervisor verdict prevents productive follow-up");
      assert.equal(h.state("mem:room1").task?.recoveryAdmission, undefined);
      await h.recoverTasks(); await h.tick(); await h.drained();
      assert.equal(turns, 1, "completed work is not replayed");
      assert.equal(assessed.length, 1);
    } finally { await h.stop(0); }
  });
}

for (const mode of ["inconclusive", "failed"] as const) {
  test(`${mode} assessment never implies completed`, async () => {
    let now = 1000;
    const h = new Harness({ runtime: new FakeRuntime(() => "Work might remain"), tickMs: 60000, now: () => now,
      completionCheck: async () => { if (mode === "failed") throw Error("provider unavailable"); return undefined; } });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Implement and test the update")); await h.drained();
      assert.equal(h.state("mem:room1").task?.state, "active");
      await h.recoverTasks(); h.releaseRestored(); await h.drained();
      assert.equal(h.state("mem:room1").task?.state, "active");
      assert.equal(h.state("mem:room1").task?.recoveryRetry?.attempts, 1);
      // main already reserves technical retries at normal-turn settlement.
      // Diagnose the next due failure, not an intentionally suppressed early call.
      now = h.state("mem:room1").task!.recoveryRetry!.nextAt;
      await h.recoverTasks();
      assert.equal(h.state("mem:room1").task?.recoveryRetry?.attempts, 2);
      assert.match(h.state("mem:room1").task?.recoveryAttentionId!, /^task-recovery:/);
      assert.equal(h.state("mem:room1").task?.termination, undefined);
      assert.equal(h.outboxEntries().length, 0, "diagnostics are default-off");
    } finally { await h.stop(0); }
  });
}
