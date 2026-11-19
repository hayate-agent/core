import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";

test("parent takeover and worker claims are serialized and release on turn settlement", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "takeover-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("room", "worker", "work", "direct", 1, { taskId: "task", original: "work", depth: 0 });
  await store.beginTurn("turn", "room", undefined, "task");
  await assert.rejects(store.claim(child.id), /Parent is executing/);
  const delegated = await store.submit("room", "new-worker", "independent subtask", "direct", 1, { taskId: "task", original: "work", depth: 0 });
  assert.equal((await store.claim(delegated.id)).status, "running", "new delegation is not captured by an old takeover");
  await store.beginTurn("turn", "room", undefined, "task"); // Crash replay must not seize newly delegated work.
  await store.control(delegated.id, "cancel");
  await store.stopTurn("turn", "room");
  await assert.rejects(store.claim(child.id), /Parent is executing/, "stop only signals cancellation; the turn may still be running");
  await store.settleTurn("turn", "room", { outbox: [], consumed: [] });
  const claimed = await store.claim(child.id);
  await assert.rejects(store.beginTurn("other", "room", undefined, "task"), /Worker currently executing/);
  await store.fail(child.id, claimed.token!, "worker-failed");
  await store.beginTurn("other", "room", undefined, "task");
  assert.equal(store.list()[0]!.status, "paused");
});

test("takeover fence survives restart and releases when its turn settles", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "takeover-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  const child = await store.submit("room", "worker", "work", "direct", 1, { taskId: "task", original: "work", depth: 0 });
  await store.beginTurn("turn", "room", undefined, "task");
  const restored = new ExecutionStore(file); await restored.load();
  await restored.reconcileSettledTurns(new Set(["turn"]));
  assert.equal(restored.parentTakeoverActive(restored.list()[0]!), true);
  assert.equal(restored.assessmentDue(restored.list()[0]!), false);
  await assert.rejects(restored.claim(child.id), /Parent is executing/);
  await restored.settleTurn("turn", "room", { outbox: [], consumed: [] });
  assert.equal(restored.assessmentDue(restored.list()[0]!), true);
  assert.equal((await restored.claim(child.id)).status, "running");
});

test("a stopped takeover remains fenced until restart removes its orphaned turn", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "takeover-stop-restart-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  const child = await store.submit("room", "worker", "work", "direct", 1, { taskId: "task", original: "work", depth: 0 });
  await store.beginTurn("turn", "room", undefined, "task");
  await store.stopTurn("turn", "room");
  await assert.rejects(store.claim(child.id), /Parent is executing/);
  const restored = new ExecutionStore(file); await restored.load();
  await restored.reconcileSettledTurns(new Set());
  assert.equal(restored.turn("turn", "room"), undefined);
  assert.equal((await restored.claim(child.id)).status, "running");
});

test("replayed turn no longer classified as takeover releases its prior fence", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "takeover-reclassified-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  const child = await store.submit("room", "worker", "work", "direct", 1, { taskId: "task", original: "work", depth: 0 });
  await store.beginTurn("turn", "room", undefined, "task");
  const restored = new ExecutionStore(file); await restored.load();
  await restored.reconcileSettledTurns(new Set(["turn"]));
  await restored.beginTurn("turn", "room");
  assert.equal(restored.parentTakeoverActive(restored.list()[0]!), false);
  assert.equal((await restored.claim(child.id)).status, "running");
});

test("a failed turn releases its fence without discarding the durable turn", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "takeover-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("room", "worker", "work", "direct", 1, { taskId: "task", original: "work", depth: 0 });
  await store.beginTurn("turn", "room", undefined, "task");
  await store.releaseTurnTakeover("turn", "room");
  assert.equal(store.turn("turn", "room")?.state, "running");
  const claimed = await store.claim(child.id);
  await assert.rejects(store.beginTurn("turn", "room", undefined, "task"), /Worker currently executing/);
  await store.fail(child.id, claimed.token!, "worker-failed");
  await store.beginTurn("turn", "room", undefined, "task");
  assert.equal(store.parentTakeoverActive(store.list()[0]!), true);
});

test("restart retains the original takeover snapshot without capturing new delegates", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "takeover-snapshot-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json");
  const initial = new ExecutionStore(file); await initial.load();
  const dependency = { taskId: "task", original: "work", depth: 0 };
  const old = await initial.submit("room", "old", "work", "direct", 1, dependency);
  await initial.beginTurn("turn", "room", undefined, "task");
  const delegated = await initial.submit("room", "new", "other work", "direct", 1, dependency);
  const restored = new ExecutionStore(file); await restored.load();
  await restored.reconcileSettledTurns(new Set(["turn"]));
  await restored.beginTurn("turn", "room", undefined, "task");
  await assert.rejects(restored.claim(old.id), /Parent is executing/);
  assert.equal((await restored.claim(delegated.id)).status, "running");
  await restored.reconcileSettledTurns(new Set());
  assert.equal((await restored.claim(old.id)).status, "running", "orphaned turn no longer owns the old execution");
});

test("a take-over claim and retry claim cannot both win concurrently", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "takeover-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("room", "worker", "work", "direct", 1, { taskId: "task", original: "work", depth: 0 });
  const results = await Promise.allSettled([store.beginTurn("turn", "room", undefined, "task"), store.claim(child.id)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
});
