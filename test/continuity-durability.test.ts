import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "mem:room1";
test("failed reconciliation persistence holds working execution; real tick retries once", async () => {
  const channel = new MemoryChannel();
  let turns = 0, now = 1000;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; h.planContinuation(key, { state: "completed" }); return "Verified"; }), tickMs: 60000, now: () => now,
    completionCheck: async input => input.continuationDepth ? { state: "completed" } : { state: "continue", next: "Verify pending work" } }); h.addChannel(channel);
  h.restoreSessions([{ key, replyTo: { channel: "mem", target: "room1" }, task: {
    id: "t", original: "Verify pending work", state: "active", depth: 0
  } }]);
  let offline = true;
  h.onStateChange = async () => { if (offline) throw Error("disk offline"); };
  try {
    await assert.rejects(h.tick(), /disk offline/); assert.equal(channel.sent.length, 0); assert.equal(turns, 0);
    offline = false; now += 60001; await h.tick(); await h.drained();
    assert.equal(turns, 1);
    await h.tick(); await h.drained(); assert.equal(turns, 1);
  } finally { await h.stop(0); }
});

test("restored admitted inbox deduplicates recovery; completed retained state revokes stale queued admission", async () => {
  for (const completed of [false, true]) {
    let prompts = 0;
    const h = new Harness({ runtime: new FakeRuntime(() => { prompts++; h.planContinuation(key, { state: "completed" }); return "Verified effects"; }), tickMs: 60000 });
    h.onStateChange = async () => {};
    h.restoreSessions([{ key, task: { id: "t", original: "Verify effects", state: completed ? "completed" : "active", depth: 0,
      next: "Inspect", recoveryAssessment: "decided",
      recoveryAdmission: { id: "task:t:1", depth: 1, next: "Inspect", original: "Verify effects" } } }]);
    h.restoreSeen(["task:t:1"]);
    h.restorePending([{ id: "task:t:1", source: "cron", sessionKey: key, taskId: "t", continuationDepth: 1, text: "Inspect effects" }]);
    try {
      await h.recoverTasks(); h.releaseRestored(); await h.drained(); await h.tick(); await h.drained();
      assert.equal(prompts, completed ? 0 : 1); assert.equal(h.pendingInputs().length, 0);
    } finally { await h.stop(0); }
  }
});
