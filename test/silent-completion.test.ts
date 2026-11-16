import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const explicit of [true, false]) test(`silent terminal rechecks are bounded and silent (checkpoint=${explicit})`, async () => {
  let turns = 0, checks = 0, h!: Harness;
  const ch = new MemoryChannel();
  Object.assign(ch, { editableProgress: true, turnStatus: async () => {}, turnEvent: () => {} });
  const runtime = new FakeRuntime(() => {
    turns++;
    if (explicit) h.planContinuation("mem:room1", { state: "completed" });
    return "NO_REPLY";
  });
  h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => {
    checks++; return { state: "continue", next: "Independently verify the completed result once more" };
  } });
  h.addChannel(ch); h.onStateChange = async () => {};
  try {
    await h.submit({ ...msg("Repair and verify"), progressId: "progress:original" }); await h.drained();
    const task = h.state("mem:room1").task!;
    assert.equal(turns, 2); assert.equal(checks, 2);
    assert.equal(ch.sent.length, 0, "NO_REPLY must not become a progress completion bubble");
    assert.equal(task.state, "blocked", "do not ratify an unverified completion claim");
    assert.equal(task.supervisorDecision?.silentCompletionRecheck, "exhausted");
    assert.equal(task.recoveryRetry, undefined);
    const restored = new Harness({ runtime, tickMs: 60000, completionCheck: async () => { throw Error("held task must not recover automatically"); } });
    try {
      restored.restoreSessions(structuredClone(h.snapshotSessions()));
      restored.recoverTasks(); await restored.drained();
      assert.equal(turns, 2, "the bounded hold survives restart");
    } finally { await restored.stop(1000); }
  } finally { await h.stop(1000); }
});

test("silent terminal rechecks still permit real verification work", async () => {
  let turns = 0, h!: Harness;
  const ch = new MemoryChannel();
  const runtime = new FakeRuntime(() => {
    turns++;
    if (turns === 2) {
      const event = runtime.sessions.get("mem:room1")!.options.at(-1)!.onEvent;
      event?.({ type: "tool", phase: "start", name: "read" });
      event?.({ type: "tool", phase: "end", name: "read", detail: "verified deployed revision" });
    }
    h.planContinuation("mem:room1", { state: "completed" });
    return "NO_REPLY";
  });
  h = new Harness({ runtime, tickMs: 60000,
    completionCheck: async () => turns < 3 ? { state: "continue", next: "Verify remaining deployment evidence" } : { state: "completed" } });
  h.addChannel(ch); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Repair and verify")); await h.drained();
    assert.equal(turns, 3, "real verification must not be mistaken for a no-work loop");
    assert.notEqual(h.state("mem:room1").task?.supervisorDecision?.silentCompletionRecheck, "exhausted");
    assert.equal(ch.sent.length, 0);
  } finally { await h.stop(1000); }
});

test("NO_REPLY with progress stays silent; substantive and failed replies retain delivery", async () => {
  for (const result of ["NO_REPLY", "Delivered and verified", "failure"]) {
    const ch = new MemoryChannel();
    const runtime = new FakeRuntime(() => { if (result === "failure") throw Error("backend failed"); return result; });
    const h = new Harness({ runtime, tickMs: 60000 }); h.addChannel(ch);
    try {
      await h.submit({ ...msg("hello"), progressId: "progress:original" }); await h.drained();
      assert.equal(ch.sent.length, result === "NO_REPLY" ? 0 : 1);
      if (result !== "NO_REPLY") {
        assert.equal(ch.sent[0]?.meta?.progressId, "progress:original");
        assert.match(ch.sent[0]!.text, result === "failure" ? /backend failed/ : /Delivered and verified/);
      }
    } finally { await h.stop(1000); }
  }
});
