import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { assessCompletion } from "./completion-default.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
for (const checkpoint of ["blocked", "completed", "waiting"] as const) test(`published PR with ${checkpoint} executes assessor's remaining authorized integration step`, async () => {
  let turns = 0, checks = 0, saved = false;
  const original = "Implement, review and publish the fix, then merge on required green CI and deliver via GitOps";
  const runtime = new FakeRuntime(() => {
    turns++;
    if (turns === 2) assert.ok(saved);
    h.planContinuation(key, turns === 1 ? { state: checkpoint, ...(checkpoint === "waiting" ? {
      next: "Recheck release", wait: { reason: "Release pending", retryAfterMs: 60000, deadline: 500000 },
    } : {}) } : { state: "completed" });
    return turns === 1 ? "PR published and open; awaiting merge" : "Required delivery verified";
  });
  const h = new Harness({ runtime, tickMs: 60000, now: () => 1000, completionCheck: (input, reply, signal) =>
    assessCompletion({ review: async prompt => {
      checks++;
      const data = JSON.parse(prompt.slice(prompt.indexOf("DATA: ") + 6));
      assert.equal(data.task, original);
      return JSON.stringify(checks === 1 ? { state: "continue", next: "Verify required CI, then merge only if green within the original mandate" } : { state: "completed" });
    } }, input, reply, { task: input.completionAnchor!.task }, signal, undefined, () => 1000) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {
    if (h.pendingInputs().some(i => i.continuationDepth === 1)) saved = true;
  };
  try {
    await h.submit(msg(original)); await h.drained();
    assert.equal(turns, 2); assert.equal(checks, 2);
    assert.equal(h.snapshotSessions()[0].tasks![0].state, "completed");
  } finally { await h.stop(0); }
});

test("independent required-approval verdict keeps model-blocked work blocked, not completed or executable", async () => {
  let checks = 0;
  const runtime = new FakeRuntime(() => {
    h.planContinuation(key, { state: "blocked", next: "Approve protected environment deployment for PR179" });
    return "PR is published; protected deployment approval is still pending";
  });
  const channel = new MemoryChannel();
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => {
    checks++; return { state: "blocked" };
  } });
  h.addChannel(channel); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Deliver the fix, preserving the required environment approval")); await h.drained();
    await h.recoverTasks(); await h.tick(); await h.drained();
    assert.equal(checks, 1);
    assert.equal(h.snapshotSessions()[0].tasks![0].state, "blocked");
    assert.equal(runtime.sessions.get(key)!.prompts.length, 1);
    assert.match(channel.texts().join("\n"), /protected deployment approval is still pending/);
    assert.equal(h.pendingInputs().length, 0);
  } finally { await h.stop(0); }
});
