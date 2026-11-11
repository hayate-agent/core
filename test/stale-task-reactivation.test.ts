import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime } from "./fakes.js";

const key = "main";
const now = 2_000_000_000_000;
function task(id: string, explicitBlocked = false): DurableTask {
  return { id, original: `Old operator request ${id}`, state: "blocked", depth: 0, explicitBlocked,
    anchor: { id: `anchor-${id}`, task: `Old operator request ${id}`, receivedAt: now - 8 * 86400000 } };
}
async function fixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), "stale-task-"));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  let assessments = 0;
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, now: () => now,
    completionCheck: async () => { assessments++; return { state: "continue", next: "Inspect another independent step" }; } });
  h.onStateChange = async () => {};
  t.after(async () => { await h.stop(0); await rm(home, { recursive: true, force: true }); });
  return { h, store, assessments: () => assessments };
}
async function child(store: ExecutionStore, parentTask?: DurableTask) {
  const job = await store.submit(key, "worker", "Old worker", "direct", 1,
    parentTask ? { taskId: parentTask.id, original: parentTask.original, depth: 0 } : undefined);
  const claim = await store.claim(job.id);
  await store.intent(job.id, claim.token!, "uncertain-effect", "unsafe");
  await store.fail(job.id, claim.token!, "runtime-failure");
  return job;
}

test("one unscoped blocked worker must not mint autonomous admissions for multiple historical tasks", async t => {
  const f = await fixture(t); await child(f.store);
  const tasks = [task("old-A"), task("old-B")];
  f.h.restoreSessions([{ key, tasks }]);
  await f.h.recoverTasks();
  assert.equal(f.assessments(), 0, "unknown ownership is a blocker, not authority for model-selected independent work");
  assert.equal(f.h.pendingInputs().length, 0);
  for (const row of f.h.snapshotSessions()[0]!.tasks!) {
    assert.equal(row.state, "blocked"); assert.equal(row.recoveryAdmission, undefined);
  }
  assert.equal(f.store.list()[0]!.status, "blocked");
});

test("a saved independent admission based only on unscoped children remains fenced after restart", async t => {
  const f = await fixture(t); await child(f.store);
  const old = task("old-A"); old.state = "active"; old.next = "Inspect another independent step";
  const evidence = createHash("sha256").update(JSON.stringify(f.store.list(key))).digest("hex");
  old.supervisorDecision = { verdict: "continue", dependencyHold: { reason: "independent-next-proposed", evidence, next: old.next } };
  old.recoveryAdmission = { id: `task:${old.id}:1`, depth: 1, next: old.next, original: old.original,
    independent: { evidence, taskId: old.id, sessionKey: key } };
  f.h.restoreSessions([{ key, tasks: [old] }]);
  await f.h.recoverTasks();
  assert.equal(f.h.pendingInputs().length, 0, "matching hash of unknown workers is not task provenance");
  assert.equal(f.h.snapshotSessions()[0]!.tasks![0]!.recoveryAdmission, undefined);
});

test("a scoped child's assessment cannot reactivate another historical task", async t => {
  const f = await fixture(t); const old = task("old-A", true); const other = task("old-B");
  await child(f.store, old);
  f.h.restoreSessions([{ key, tasks: [old, other] }]);
  await f.h.recoverTasks();
  assert.equal(f.assessments(), 1, "only the exact parent is assessed");
  assert.equal(f.h.pendingInputs().length, 1);
  assert.equal(f.h.snapshotSessions()[0]!.tasks!.find(t => t.id === other.id)!.state, "blocked");
});

test("an expired legacy wait without task expiry is held instead of becoming active on tick", async t => {
  const f = await fixture(t); const old = task("old-poll");
  old.state = "waiting"; old.next = "Check the old condition";
  old.wait = { reason: "Old bounded polling", nextAt: now - 8 * 86400000, deadline: now - 7 * 86400000 };
  f.h.restoreSessions([{ key, tasks: [old] }]);
  await f.h.tick();
  const saved = f.h.snapshotSessions()[0]!.tasks![0]!;
  assert.equal(saved.state, "blocked");
  assert.equal(saved.recoveryEnrollment, "held-legacy");
  assert.ok(saved.wait, "original checkpoint retained, not erased or extended");
  assert.equal(saved.expiresAt, undefined);
  await f.h.tick();
  assert.equal(f.assessments(), 0, "the next idle boundary cannot reenroll the historical mandate");
});

test("an exact scoped child may still admit independent work for its non-held parent", async t => {
  const f = await fixture(t); const old = task("old-A"); await child(f.store, old);
  f.h.restoreSessions([{ key, tasks: [old] }]);
  await f.h.recoverTasks();
  assert.equal(f.assessments(), 1);
  assert.equal(f.h.pendingInputs().length, 1);
  assert.equal(f.h.snapshotSessions()[0]!.tasks![0]!.recoveryAdmission?.independent?.taskId, old.id);
});
