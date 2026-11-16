import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { Subagents, type SubagentRecord } from "../src/subagents.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "startup-noop-revoke-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json"), store = new ExecutionStore(file); await store.load();
  const storage = (store as any).storage, original = storage.save.bind(storage); let saves = 0;
  storage.save = async (...args: unknown[]) => { saves++; return original(...args); };
  return { store, file, saves: () => saves, storage };
}

test("78 childless stopped mandates reconcile without rewriting ledger or host state", async t => {
  const { store, saves } = await fixture(t); let hostSaves = 0;
  const harness = new Harness({ runtime: new FakeRuntime(), executionStore: store, tickMs: 60000,
    taskStopped: (key, task) => subagents.cancelTaskChildren(key, task) });
  const subagents = new Subagents(harness, async () => { hostSaves++; });
  harness.restoreSessions([{ key: "matrix:retained", tasks: Array.from({ length: 78 }, (_, i) => ({
    id: `stopped-${i}`, original: "Stopped original mandate", state: "stopped" as const, depth: 0,
  })) }]);
  await harness.reconcileStoppedTasks();
  assert.equal(saves(), 0); assert.equal(hostSaves, 0);
  assert.equal(harness.pendingInputs().length, 0);
});

test("no-op revocation still joins prior accepted writes and commits actual cancellation once", async t => {
  const { store, file, saves } = await fixture(t);
  const submitted = store.submit("parent", "original", "Original accepted work", "fixture");
  const cancelled = store.cancelParent("parent");
  await Promise.all([submitted, cancelled]);
  assert.equal(store.list("parent")[0].status, "cancelled");
  assert.equal(store.list("parent")[0].parentStopped, true);
  const count = saves(); assert(count > 0);
  const original = JSON.stringify(store.list());
  await store.cancelParent("parent"); await store.cancelParent("missing");
  assert.equal(saves(), count); assert.equal(JSON.stringify(store.list()), original);
  const restored = new ExecutionStore(file); await restored.load();
  assert.equal(restored.list("parent")[0].status, "cancelled");
  assert.equal(restored.list("parent")[0].parentStopped, true);
});

test("revocation write failure is retried durably; a no-op never bypasses writer ownership", async t => {
  const { store, storage } = await fixture(t);
  await store.submit("parent", "request", "Existing work", "fixture");
  const save = storage.save.bind(storage); let fail = true;
  storage.save = async (...args: unknown[]) => { if (fail) throw Error("fixture write failure"); return save(...args); };
  await assert.rejects(store.cancelParent("parent"), /fixture write failure/);
  assert.equal(store.list("parent")[0].status, "ready");
  fail = false; await store.cancelParent("parent"); assert.equal(store.list("parent")[0].status, "cancelled");
  storage.assertWritable = () => { throw Error("fixture ownership lost"); };
  await assert.rejects(store.cancelParent("missing"), /fixture ownership lost/);
});

test("task-scoped legacy holds are committed and preserved, never converted to replay permission", async t => {
  const { store, file, saves } = await fixture(t);
  const task = await store.submit("parent", "unscoped", "Legacy uncertain work", "fixture");
  await store.cancelTask("parent", "stopped-task");
  const current = store.list()[0]; assert.equal(current.id, task.id);
  assert.equal(current.ownershipHold, "unscoped-parent-stop"); assert.equal(current.status, "blocked");
  const count = saves(); await store.cancelTask("parent", "stopped-task"); assert.equal(saves(), count);
  const restored = new ExecutionStore(file); await restored.load();
  assert.equal(restored.list()[0].ownershipHold, "unscoped-parent-stop");
  assert.equal(restored.list()[0].status, "blocked");
});

const child = (id: string, task?: string): SubagentRecord => ({ id, parent: "parent", parentTaskId: task,
  sessionKey: `subagent:${id}`, state: "completed", expiresAt: 1,
  handover: { task: "Original", context: "Retained", constraints: "No replay", expectedResult: "Evidence", acceptance: "Verified", model: "p/m", thinking: "off" } });

test("other scoped subagents cause no write; matching and unscoped children retain durable revocation barriers", async () => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); let saves = 0, fail = false;
  const subagents = new Subagents(harness, async () => { if (fail) throw Error("fixture host save failed"); saves++; });
  subagents.restore([child("other", "other-task")]);
  await subagents.cancelTaskChildren("parent", "stopped-task"); assert.equal(saves, 0);
  assert.equal(subagents.get("parent", "other").parentStopped, undefined);
  subagents.restore([child("matching", "stopped-task"), child("legacy")]); fail = true;
  await assert.rejects(subagents.cancelTaskChildren("parent", "stopped-task"), /fixture host save failed/);
  assert.equal(saves, 0);
  fail = false; await subagents.cancelTaskChildren("parent", "stopped-task");
  assert.equal(saves, 1);
  assert.equal(subagents.get("parent", "matching").parentStopped, true);
  assert.equal(subagents.get("parent", "legacy").ownershipHold, "unscoped-parent-stop");
  assert.equal(subagents.get("parent", "legacy").state, "completed");
});
