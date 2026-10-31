import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { Inbound } from "../src/types.js";
import type { ExecutionStore } from "../src/execution.js";

test("independent completion check receives recent corrections and retained mandates across restart", async () => {
  const runtime = new FakeRuntime();
  let observed: Inbound | undefined;
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async input => { observed = input; return undefined; } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Implement the architecture, not just a single PR")); await h.drained();
    await h.submit(msg("A merged child PR does not complete the parent task")); await h.drained();
    assert.ok(observed?.completionContext?.recent.some(m => m.role === "user" && m.text.includes("not just a single PR")));
    assert.ok(observed?.completionContext?.tasks.some(t => t.original.includes("architecture")));
    const restored = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, completionCheck: async input => { observed = input; return undefined; } });
    restored.addChannel(new MemoryChannel()); restored.onStateChange = async () => {};
    try {
      restored.restoreSessions(h.snapshotSessions());
      await restored.submit(msg("Is the original task actually finished?")); await restored.drained();
      assert.ok(observed?.completionContext?.recent.some(m => m.text.includes("does not complete the parent")));
      assert.ok(observed?.completionContext?.tasks.some(t => t.original.includes("architecture")));
    } finally { await restored.stop(0); }
  } finally { await h.stop(0); }
});

test("child wait and child dependency do not suppress independent parent assessment or safe work", async () => {
  const runtime = new FakeRuntime(); let h: Harness; let checks = 0;
  runtime.answer = (text, key) => {
    if (text.includes("Original task:")) h.planContinuation(key, { state: "completed" });
    else h.planContinuation(key, { state: "waiting", next: "verify child image", wait: { reason: "image pending", retryAfterMs: 60000, deadline: 301000 } });
    return "step settled";
  };
  const store = { turn: () => undefined, beginTurn: async () => {}, settleTurn: async () => {}, acknowledgeTurn: async () => {}, list: () => [{ id: "child", status: "running", dependency: { taskId: "child-task" } }] } as unknown as ExecutionStore;
  h = new Harness({ runtime, executionStore: store, tickMs: 60000, now: () => 1000,
    completionCheck: async input => {
      checks++;
      return input.taskId === "parent" ? input.source === "heartbeat"
        ? { state: "continue", next: "test unrelated architecture contract" } : { state: "completed" } : undefined;
    } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", tasks: [{ id: "parent", original: "Implement architecture contracts", state: "active", depth: 0,
    anchor: { id: "parent", task: "Implement architecture contracts", receivedAt: 0 } }] }]);
  try {
    await h.submit(msg("Deliver child image")); await h.drained();
    const tasks = h.snapshotSessions()[0].tasks!;
    assert.ok(checks >= 2, "child wait and parent must both be independently assessed");
    assert.equal(tasks.find(t => t.id === "parent")!.state, "completed");
    assert.ok(tasks.some(t => t.wait?.nextAt === 61000 && t.next === "verify child image"));
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 2);
  } finally { await h.stop(0); }
});
