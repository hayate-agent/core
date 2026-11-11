import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

for (const status of ["ready", "paused"] as const)
test(`authentic parent expiry remains binding while child is ${status}`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-expiry-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "ledger.json")); await store.load();
  const child = await store.submit("mem:room1", "r", "work", "direct", 1, { taskId: "p", original: "Deliver", depth: 0 });
  if (status === "paused") await store.control(child.id, "pause");
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, now: () => 100000 });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  h.restoreSessions([{ key: "mem:room1", task: { id: "p", original: "Deliver", state: "waiting", depth: 0,
    expiresAt: 100000, next: "Check worker", wait: { reason: "Worker pending", nextAt: 200000, deadline: 300000 } } }]);
  await h.tick(); await h.drained();
  assert.equal(h.snapshotSessions()[0].task!.termination, "deadline_expired");
  assert.equal(store.list()[0].status, status);
});

test("request-ID dedup cannot silently retain a looser task deadline", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-dedup-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "ledger.json")); await store.load();
  const mandate = { taskId: "p", original: "work", depth: 0, expiresAt: 300000 };
  const first = await store.submit("parent", "stable", "work", "direct", 1, mandate);
  await assert.rejects(store.submit("parent", "stable", "work", "direct", 1, { ...mandate, expiresAt: 200000 }), /looser mandate deadline/);
  assert.equal((await store.submit("parent", "stable", "work", "direct", 1, mandate)).id, first.id);
});

test("repeated worker failures atomically retain the most recent transcript and retry window", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-transcript-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000; const file = path.join(dir, "ledger.json");
  const store = new ExecutionStore(file, { now: () => now }); await store.load();
  const strategy = { strategy: "direct", version: 1, replaySafe: false, reconcile: true };
  const task = await store.submit("parent", "r", "work", "direct");
  for (let attempt = 1; attempt <= 5; attempt++) {
    const claim = await store.claim(task.id, strategy);
    if (!claim.intent) await store.intent(task.id, claim.token!, "effect", "unsafe");
    await store.fail(task.id, claim.token!, "worker-failed", { strategy });
    const row = store.list()[0];
    assert.equal(row.status, "ready");
    assert.equal(row.recoverySession, `dispatch:${task.id}:${claim.token}`);
    assert.equal(row.workerRetry!.attempts, attempt);
    assert.equal(row.intent?.key, "effect");
    const reloaded = new ExecutionStore(file, { now: () => now }); await reloaded.load();
    assert.deepEqual(reloaded.list()[0], JSON.parse(JSON.stringify(row)));
    now = row.workerRetry!.nextAt;
  }
});
