import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore, ExecutionAssessmentHold } from "../src/execution.js";
import { Dispatcher } from "../src/dispatcher.js";
import { dispatcherEventPresentation } from "../src/notification-routing.js";

for (const state of ["blocked", "waiting"] as const) test(`semantic ${state} is not a transport failure, including after restart`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "semantic-hold-"));
  const file = path.join(home, "executions.json");
  let now = 1000, calls = 0;
  const store = new ExecutionStore(file, { now: () => now, workerRetryMax: 1 }); await store.load();
  const strategy = { name: "semantic", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { calls++; throw new ExecutionAssessmentHold(state, 0, "external dependency"); } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {});
  let resumed: Dispatcher | undefined;
  t.after(async () => { await dispatcher.stop(); await resumed?.stop(); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start();
  const task = await dispatcher.submit("matrix:room", "request", "work");
  await dispatcher.waitForExecution(task.id);
  const held = store.list()[0];
  assert.equal(held.diagnosticCode, `assessment-${state}`);
  assert.equal(held.workerRetry, undefined);
  assert.equal(held.assessmentRetryAt, undefined);
  assert.deepEqual(held.assessmentHold, { state, step: 0 });
  now += 86400000; for (let i = 0; i < 10; i++) await dispatcher.kick();
  assert.equal(calls, 1);
  await dispatcher.stop();
  const reload = new ExecutionStore(file, { now: () => now }); await reload.load();
  resumed = new Dispatcher(reload, strategy, 1, async () => {}, () => {});
  await resumed.start(); await resumed.kick(); assert.equal(calls, 1);
  await resumed.control("matrix:room", task.id, "resume");
  await resumed.waitForExecution(task.id); assert.equal(calls, 2, "explicit control may reassess");
  assert.equal(reload.list()[0].diagnosticCode, `assessment-${state}`);
});

for (const diagnostic of ["runtime-failure", "retry-exhausted"] as const) test(`legacy ${diagnostic} with a semantic hold migrates without a worker replay`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "semantic-migrate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file, { now: () => 1000 }); await store.load();
  const task = await store.submit("parent", "request", "work", "sequential");
  const claim = await store.claim(task.id);
  await store.intent(task.id, claim.token!, "step:original", "unsafe");
  await store.checkpoint(task.id, claim.token!, "retained worker evidence");
  await store.fail(task.id, claim.token!, "runtime-failure");
  const ledger = JSON.parse(await readFile(file, "utf8"));
  Object.assign(ledger.executions[0], { diagnosticCode: diagnostic, assessmentHold: { state: "blocked", step: 0 }, workerRetry: { attempts: 11, nextAt: 1001 } });
  await writeFile(file, JSON.stringify(ledger));
  const reload = new ExecutionStore(file, { now: () => 999999 }); await reload.load();
  await reload.recover(new Map([["sequential", { version: 1, replaySafe: false, reconcile: true }]]));
  const held = reload.list()[0];
  assert.equal(held.diagnosticCode, "assessment-blocked");
  assert.equal(held.status, "blocked"); assert.equal(held.workerRetry, undefined);
  assert.equal(held.checkpoint, "retained worker evidence"); assert.equal(held.intent?.key, "step:original");
  await reload.retryWorker(task.id, { version: 1, replaySafe: false, reconcile: true });
  assert.deepEqual(reload.list()[0], held);
});

test("a new child request ID cannot bypass a stagnant parent mandate; another mandate remains runnable", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "semantic-submit-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const mandate = { taskId: "operator-task", original: "deliver", depth: 0 };
  const task = await store.submit("parent", "first", "inspect", "sequential", 1, mandate);
  const claim = await store.claim(task.id);
  await store.fail(task.id, claim.token!, "assessment-stalled");
  await assert.rejects(store.submit("parent", "replacement", "reworded inspection", "sequential", 1, mandate), /execution-held/);
  assert.equal((await store.submit("parent", "first", "inspect", "sequential", 1, mandate)).id, task.id);
  await store.submit("parent", "independent", "other work", "sequential", 1, { ...mandate, taskId: "another-task" });
  assert.equal(store.list().length, 2);
});

test("internal dispatcher events never reach ordinary chat, even with Matrix cron continuation parents", () => {
  const base = { id: "event", parent: "matrix:room", executionId: "task", type: "status" as const, status: "running" as const, text: "Plan: medium — internal reasoning" };
  for (const channel of ["matrix", "slack", "console", undefined]) {
    for (const parent of ["matrix:room", "cron:audit", "cron-followup:report", "improvement:nightly"]) {
      assert.equal(dispatcherEventPresentation({ ...base, parent }, "paused", channel), undefined);
    }
    assert.equal(dispatcherEventPresentation({ ...base, type: "question" }, "running", channel), "attention");
    assert.equal(dispatcherEventPresentation({ ...base, status: "paused", text: "new blocker", requiresAttention: true }, "paused", channel), "attention");
    assert.equal(dispatcherEventPresentation({ ...base, status: "paused", automaticRetryAt: 999999 }, "paused", channel), undefined);
  }
  assert.equal(dispatcherEventPresentation(base, "running", "api"), "progress");
  assert.equal(dispatcherEventPresentation({ ...base, type: "result" }, "completed", "matrix"), undefined, "results retain their separate durable inbox path");
});
