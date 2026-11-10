import assert from "node:assert/strict";
import test from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

for (const restart of [false, true]) test(`deferred assessment does not starve a later admitted Main task (restart=${restart})`, async () => {
  const key = "mem:room1";
  const deferred: DurableTask = { id: "deferred", original: "Inspect service A only", state: "active", depth: 0,
    next: "Read A receipt", recoveryAssessment: "claimed", recoveryRetry: { attempts: 5, nextAt: 1000000 } };
  const admitted: DurableTask = { id: "admitted", original: "Inspect service B only", state: "active", depth: 0,
    next: "Read B receipt", lastReply: "I will inspect B" };
  let turns = 0, checks = 0, saved = "", h: Harness;
  const opts = { now: () => 1000, tickMs: 600000,
    runtime: new FakeRuntime(input => {
      assert.match(input, /Read B receipt/);
      assert.doesNotMatch(input, /Read A receipt/);
      assert.match(saved, /recoveryAdmission/, "admission saved before work");
      turns++; return "B receipt inspected";
    }),
    completionCheck: async (input: import("../src/types.js").Inbound) => {
      assert.equal(input.taskId, admitted.id, "A must not be reassessed before its retry is due");
      checks++;
      return turns ? { state: "completed" as const } : { state: "continue" as const, next: "Read B receipt" };
    } };
  const create = () => {
    const instance = new Harness(opts); instance.addChannel(new MemoryChannel());
    instance.onStateChange = async () => { saved = JSON.stringify(instance.snapshotSessions()); };
    return instance;
  };
  h = create(); h.restoreSessions([{ key, task: deferred, tasks: [deferred, admitted] }]);
  try {
    if (restart) {
      saved = JSON.stringify(h.snapshotSessions()); await h.stop(0);
      h = create(); h.restoreSessions(JSON.parse(saved));
    }
    await h.tick(); h.releaseRestored(); await h.drained();
    assert.equal(turns, 1, "B must run despite A's deferred assessment");
    assert.equal(checks, 2);
    const tasks = h.snapshotSessions()[0].tasks!;
    assert.deepEqual(tasks.find(t => t.id === deferred.id), deferred, "deferred A remains fenced and unchanged");
    assert.equal(tasks.find(t => t.id === admitted.id)!.state, "completed");
    for (let i = 0; i < 5; i++) { await h.tick(); await h.drained(); }
    assert.equal(turns, 1); assert.equal(checks, 2);
  } finally { await h.stop(0); }
});
