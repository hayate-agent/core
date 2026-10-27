import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import { assessCompletion } from "./completion-default.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { ExecutionStore } from "../src/execution.js";

const original = "Implement update and verify its regression test";
const task = (): DurableTask => ({ id: "retained", original, state: "active", depth: 2 });

test("startup missing next assesses retained mandate, executes resumed turn and never repeats on restart", async () => {
  let checks = 0, turns = 0, claimSaved = false;
  const runtime = new FakeRuntime(() => { turns++; return "Verified: update and regression already complete"; });
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: (input, reply, signal) =>
    assessCompletion({ review: async prompt => {
      checks++;
      assert.ok(claimSaved);
      assert.match(prompt, /Implement update and verify its regression test/);
      return checks === 1 ? '{"state":"continue","next":"Inspect actual update and test evidence without repeating changes"}' : '{"state":"completed"}';
    } }, input, reply, input.completionAnchor ? { task: input.completionAnchor.task } : undefined, signal) });
  h.addChannel(new MemoryChannel());
  h.restoreSessions([{ key: "mem:room1", task: task() }]);
  h.onStateChange = async () => { if (h.state("mem:room1").task?.recoveryAssessment === "claimed") claimSaved = true; };
  try {
    await Promise.all([h.recoverTasks(), h.recoverTasks()]);
    assert.equal(h.pendingInputs().length, 1);
    assert.match(h.pendingInputs()[0].text, /First reconcile/);
    h.releaseRestored(); await h.drained();
    assert.equal(turns, 1); assert.equal(checks, 2);
    await h.recoverTasks(); await h.tick(); await h.drained();
    assert.equal(turns, 1);
    const checkpoint = JSON.parse(JSON.stringify({ sessions: h.snapshotSessions(), pending: h.pendingInputs() }));
    const next = new Harness({ runtime, tickMs: 60000, completionCheck: async () => { throw Error("must not repeat"); } });
    next.onStateChange = async () => {};
    try {
      next.restoreSessions(checkpoint.sessions); next.restorePending(checkpoint.pending);
      await next.recoverTasks(); next.releaseRestored(); await next.drained();
      assert.equal(turns, 1); assert.equal(next.pendingInputs().length, 0);
    } finally { await next.stop(1000); }
  } finally { await h.stop(1000); }
});

test("startup fences states, expiry, depth, absent mandate and accepted children", async () => {
  for (const fence of ["waiting", "blocked", "completed", "stopped", "expired", "depth", "missing", "ready", "running", "paused-child", "blocked-child", "cancelled-parent", "paused", "anchor-mismatch"] as const) {
    let checks = 0;
    const runtime = new FakeRuntime();
    const child = ["ready", "running", "paused-child", "blocked-child"].includes(fence);
    const executionStore = child ? { list: () => [{ id: "accepted", status: fence.replace("-child", "") }] } as unknown as ExecutionStore : undefined;
    const h = new Harness({ runtime, tickMs: 60000, now: () => 1000, executionStore,
      completionCheck: async () => { checks++; return { state: "continue", next: "duplicate work" }; } });
    const retained = task();
    if (["waiting", "blocked", "completed", "stopped"].includes(fence)) retained.state = fence as DurableTask["state"];
    if (fence === "expired") retained.expiresAt = 1000;
    if (fence === "depth") retained.depth = 20;
    if (fence === "anchor-mismatch") retained.anchor = { id: "other", task: "unrelated mandate", receivedAt: 1 };
    h.restoreSessions([{ key: "mem:room1", ...(fence !== "missing" ? { task: retained } : {}) }]);
    h.onStateChange = async () => {};
    if (fence === "paused") h.paused = true;
    if (fence === "cancelled-parent") await h.stopConversation("mem:room1");
    try {
      await h.recoverTasks(); await h.recoverTasks(); h.releaseRestored(); await h.drained();
      assert.equal(checks, child ? 1 : 0, fence); assert.equal(runtime.sessions.size, 0, fence);
    } finally { await h.stop(1000); }
  }
});

test("startup claim survives interrupted assessment and stop/new-input races fence decisions", async () => {
  for (const mode of ["failure", "interrupted", "stop", "new-input", "expiry"] as const) {
    let checks = 0, now = 1000;
    const retained = task(); retained.expiresAt = 2000;
    if (mode === "interrupted") retained.recoveryAssessment = "claimed";
    const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, now: () => now,
      completionCheck: async () => {
        checks++;
        if (mode === "failure") throw Error("backend unavailable");
        if (mode === "stop") await h.stopConversation("mem:room1");
        if (mode === "new-input") h.enqueue(msg("new request"));
        if (mode === "expiry") now = 2000;
        return { state: "continue", next: "remaining work" };
      } });
    h.restoreSessions([{ key: "mem:room1", task: retained }]); h.onStateChange = async () => {};
    try {
      await h.recoverTasks(); await h.recoverTasks();
      assert.equal(checks, mode === "interrupted" ? 0 : 1, mode);
      assert.equal(h.pendingInputs().filter(i => i.taskId === "retained").length, 0, mode);
      const next = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, now: () => now,
        completionCheck: async () => { throw Error("must not reassess"); } });
      next.onStateChange = async () => {};
      try { next.restoreSessions(JSON.parse(JSON.stringify(h.snapshotSessions()))); await next.recoverTasks(); assert.equal(next.pendingInputs().length, 0); }
      finally { await next.stop(1000); }
    } finally { await h.stop(1000); }
  }
});

test("startup decision persistence cannot resurrect superseded task ownership", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000,
    completionCheck: async () => ({ state: "continue", next: "verify remaining test" }) });
  h.restoreSessions([{ key: "mem:room1", task: task() }]);
  h.onStateChange = async () => {
    const s = h.state("mem:room1");
    if (s.task?.recoveryAssessment === "decided") s.task = { ...task(), id: "new-authority", state: "waiting" };
  };
  try {
    await h.recoverTasks();
    assert.equal(h.pendingInputs().length, 0);
    assert.equal(h.state("mem:room1").task?.id, "new-authority");
  } finally { await h.stop(1000); }
});

test("failed checkpoint registration is rescued by independent turn-end completion assessment", async () => {
  let turns = 0, failures = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => {
    turns++;
    if (turns === 1) {
      // The tool registration is rejected before mutating the turn checkpoint.
      try { h.planContinuation("not-the-running-session", { state: "continue", next: "verify regression" }); }
      catch { failures++; }
      return "Update implemented; checkpoint registration failed; regression verification remains";
    }
    return "Regression verified; original task finished";
  }), tickMs: 60000, completionCheck: (input, reply, signal) => assessCompletion({ review: async () =>
    turns === 1 ? '{"state":"continue","next":"Verify the regression"}' : '{"state":"completed"}'
  }, input, reply, input.completionAnchor ? { task: input.completionAnchor.task } : undefined, signal) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg(original)); await h.drained();
    assert.equal(failures, 1); assert.equal(turns, 2);
    await h.recoverTasks(); await h.tick(); await h.drained(); assert.equal(turns, 2);
  } finally { await h.stop(1000); }
});
