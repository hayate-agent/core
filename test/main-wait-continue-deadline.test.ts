import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
const original = "Fix, verify, publish and deliver the product bug";
const deadline = 301000;

test("live worker events replace Main polling without shortening the authentic parent mandate", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-monitor-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  let now = 1000; let turns = 0;
  const runtime = new FakeRuntime(async () => {
    turns++;
    if (turns === 1) {
      const child = await store.submit(key, "owner", "Implement fix", "direct", 1, { taskId: "operator-task", original, depth: 0 });
      await store.claim(child.id);
    }
    h.planContinuation(key, { state: "waiting", next: "Inspect the existing worker; do not duplicate it",
      wait: { reason: "Worker verification pending", retryAfterMs: 60000, deadline: now < deadline ? deadline : now + 300000 } });
    return "147 tests passed. Full suite, build, review and publication remain open.";
  });
  const h = new Harness({ runtime, executionStore: store, now: () => now, tickMs: 600000,
    hostEventAllowed: input => store.list(key).some(e => e.id === input.hostEvent?.executionId && e.status === "completed" && !e.parentStopped),
    completionCheck: async input => input.source === "host" ? { state: "completed" } : ({ state: "continue", next: "Verify remaining original deliverables" }) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await h.accept({ ...msg(original), id: "operator-task" }); await h.drained();
  let task = h.snapshotSessions()[0].tasks!.find(t => t.id === "operator-task")!;
  assert.equal(task.state, "waiting"); assert.ok(task.wait); assert.equal(task.expiresAt, undefined);
  now = 61000; await h.tick(); await h.drained();
  assert.equal(turns, 1, "the live worker scheduler owns progress, not a Main polling turn");
  assert.equal(store.list().length, 1); assert.equal(store.list()[0].status, "running");
  now = deadline; await h.tick(); await h.drained();
  task = h.snapshotSessions()[0].tasks!.find(t => t.id === "operator-task")!;
  assert.equal(task.state, "waiting", "a running child remains monitored after the original polling window");
  assert.equal(task.wait?.nextAt, 61000, "polling metadata is retained; host events own resumption");
  assert.equal(task.termination, undefined); assert.equal(task.expiresAt, undefined);
  assert.equal(task.original, original); assert.equal(turns, 1, "no duplicate worker or blind takeover");
  now = deadline + 60000; await h.tick(); await h.drained();
  assert.equal(turns, 1, "host ownership persists beyond a model-suggested polling window");
  const child = store.list()[0];
  await store.complete(child.id, child.token!, "Verified result");
  await h.accept({ id: "durable-worker-result", source: "host", sessionKey: key, text: "Verified result",
    hostEvent: { executionId: child.id } }); await h.drained();
  assert.equal(turns, 2, "the meaningful host result wakes Main immediately, without a tick");
  assert.equal(h.snapshotSessions()[0].tasks!.find(t => t.id === "operator-task")!.state, "completed");
});

for (const trustedExpiry of [undefined, 900000, 201000])
test(`polling window does not shorten the authentic mandate (${trustedExpiry})`, async () => {
  let turns = 0;
  const runtime = new FakeRuntime(() => {
    if (++turns === 1) h.planContinuation(key, { state: "waiting", next: "Check evidence",
      wait: { reason: "Evidence pending", retryAfterMs: 60000, deadline } });
    return "checked";
  });
  const h = new Harness({ runtime, now: () => 1000, tickMs: 600000,
    continuationDeadline: () => trustedExpiry,
    completionCheck: async input => {
      if (turns === 1) return { state: "continue", next: "Perform next authorized step" };
      assert.equal(input.continuationExpiresAt, trustedExpiry);
      return { state: "completed" };
    } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.accept(msg(original)); await h.drained();
    assert.equal(turns, 2); assert.equal(h.snapshotSessions()[0].task!.expiresAt, trustedExpiry);
  } finally { await h.stop(0); }
});
