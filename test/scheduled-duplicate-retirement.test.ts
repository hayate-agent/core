import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { executionControlRequest } from "../src/execution-control.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "duplicate-retirement-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json"), { enforceTaskAuthority: true }); await store.load();
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, taskLifecycle: { enabled: true } });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const key = "matrix:repair";
  const tasks = [];
  for (const id of ["older", "newer"]) {
    const ref = await store.enrollTask(key, id, "Dynamic source reconciliation", id, "schedule");
    tasks.push({ id, taskRef: ref, original: "Dynamic source reconciliation", state: "active" as const, depth: id === "older" ? 203 : 49,
      recoveryEnrollment: "current" as const, next: "Reconcile stored receipts before effects" });
  }
  h.restoreSessions([{ key, tasks }]);
  const duplicate = store.coreTask(tasks[1].taskRef.id)!, keeper = store.coreTask(tasks[0].taskRef.id)!;
  const run = () => h.retireScheduledDuplicate(key, duplicate.id, keeper.id, duplicate.revision, keeper.revision, "operator-duplicate-repair");
  return { h, store, home, key, tasks, duplicate, keeper, run };
}

test("exact operator retirement closes only duplicate authority without deleting checkpoints or claiming business completion", async t => {
  const f = await fixture(t); const before = structuredClone(f.h.snapshotSessions());
  await f.run(); await f.run();
  assert.equal(f.store.coreTask(f.duplicate.id)!.operatorStatus, "done");
  assert.match(f.store.coreTask(f.duplicate.id)!.receipts.at(-1)!.reason!, /not business completion/);
  assert.deepEqual(f.store.coreTask(f.keeper.id), f.keeper);
  assert.deepEqual(f.h.snapshotSessions(), before);
  const reload = new ExecutionStore(path.join(f.home, "executions.json")); await reload.load();
  assert.equal(reload.coreTask(f.duplicate.id)!.operatorStatus, "done");
  assert.equal(reload.coreTask(f.keeper.id)!.operatorStatus, "open");
});

test("retirement rejects active turn, revision races, different source scope and uncertain child custody", async t => {
  const f = await fixture(t);
  f.h.state(f.key).current = { source: "cron", sessionKey: f.key, text: "ongoing" };
  await assert.rejects(f.run()); f.h.state(f.key).current = undefined;
  await assert.rejects(f.h.retireScheduledDuplicate(f.key, f.duplicate.id, f.keeper.id, 999, f.keeper.revision, "stale"));
  const child = await f.store.submit(f.key, "child", "uncertain action", "direct", 1, {
    taskId: f.tasks[1].id, taskRef: f.tasks[1].taskRef, original: f.tasks[1].original, depth: 49 });
  await assert.rejects(f.run());
  assert.equal(f.store.list().find(e => e.id === child.id)!.status, "ready");
  assert.equal(f.store.coreTask(f.duplicate.id)!.operatorStatus, "open");
});

test("queued keeper closure wins atomically and prevents retiring the only remaining open order", async t => {
  const f = await fixture(t);
  const closing = f.store.decideTask(f.tasks[0].taskRef, f.keeper.revision, "concurrent-close", "close", "Operator closes keeper");
  const repair = f.run();
  await closing; await assert.rejects(repair);
  assert.equal(f.store.coreTask(f.duplicate.id)!.operatorStatus, "open");
  assert.equal(f.store.coreTask(f.keeper.id)!.operatorStatus, "done");
});

test("scheduled retirement refuses nonscheduled lookalikes, expired keepers and changed originals", async t => {
  const f = await fixture(t);
  f.h.state(f.key).tasks![0].expiresAt = 1;
  await assert.rejects(f.run());
  delete f.h.state(f.key).tasks![0].expiresAt;
  f.h.state(f.key).tasks![1].original = "different scope";
  await assert.rejects(f.run());
  assert.equal(f.store.coreTask(f.duplicate.id)!.operatorStatus, "open");
});

test("topic-labeling await cannot enter a turn while owner retirement is reserved", async t => {
  const f = await fixture(t);
  let releaseTopic!: () => void, entered!: () => void;
  const topicGate = new Promise<void>(r => { releaseTopic = r; });
  const reached = new Promise<void>(r => { entered = r; });
  f.h.opts.topicLabeler = async () => { entered(); await topicGate; return []; };
  const s = f.h.state(f.key);
  let resumed!: () => void;
  const resumedWork = new Promise<void>(r => { resumed = r; });
  (f.h.opts.runtime as FakeRuntime).answer = () => { resumed(); return "Retained keeper work progressed"; };
  s.queue.push({ id: "foreground", source: "channel", sessionKey: f.key, text: "same",
    taskId: f.tasks[0].id, taskRef: f.tasks[0].taskRef, topicPending: { attempts: 0, nextAt: 0 } });
  const pumping = (f.h as any).pump(s) as Promise<void>;
  await reached;
  let releaseStore!: () => void;
  const storeGate = new Promise<void>(r => { releaseStore = r; });
  const original = f.store.retireScheduledDuplicate.bind(f.store);
  f.store.retireScheduledDuplicate = async (...args) => { await storeGate; return original(...args); };
  const repair = f.run(); releaseTopic(); await pumping;
  assert.equal(s.current, undefined, "no current turn may cross the reservation");
  assert.equal(s.queue.length, 1, "queued input remains retained");
  releaseStore(); await repair;
  await resumedWork;
  await f.h.waitForSessionIdle(f.key);
  assert.equal(s.queue.length, 0, "reservation release resumes retained work without a timer or new input");
  assert.equal(f.store.coreTask(f.duplicate.id)!.operatorStatus, "done");
});

test("owner socket validates exact bounded duplicate retirement frames", async () => {
  const frame = { op: "retire-scheduled-duplicate", parent: "matrix:repair", duplicate: "a".repeat(36), keeper: "b".repeat(36),
    expectedRevision: 1, keeperRevision: 2, requestId: "operator-repair" };
  let calls = 0; const retire = async () => { calls++; };
  await executionControlRequest({} as any, frame, undefined, undefined, undefined, retire);
  assert.equal(calls, 1);
  await assert.rejects(executionControlRequest({} as any, { ...frame, extra: true }, undefined, undefined, undefined, retire));
  await assert.rejects(executionControlRequest(undefined, frame, undefined, undefined, undefined, retire));
});
