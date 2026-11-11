import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore, ExecutionWorkerFailure } from "../src/execution.js";
import { Dispatcher } from "../src/dispatcher.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail("dispatcher did not settle");
}

test("EOF-equivalent worker failure retries the SAME execution through dispatcher with intent and backoff across reload", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-retry-"));
  let resumed: Dispatcher | undefined;
  const file = path.join(dir, "ledger.json"); let now = 1000;
  const store = new ExecutionStore(file, { now: () => now }); await store.load();
  let calls = 0; let execution = ""; let oldToken = "";
  const strategy = { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async (task: import("../src/execution.js").Execution, context: import("../src/dispatcher.js").DispatchContext) => {
      calls++; execution ||= task.id; assert.equal(task.id, execution);
      if (calls === 1) {
        oldToken = task.token!;
        await context.intent("uncertain-effect", "unsafe");
        throw new ExecutionWorkerFailure("worker-failed");
      }
      assert.notEqual(task.token, oldToken);
      assert.equal(task.intent?.key, "uncertain-effect");
      assert.equal(task.recoverySession, `dispatch:${task.id}:${oldToken}`);
      await context.settleIntent("uncertain-effect", "reconciled, no duplicate", "verified");
      return "done";
    } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await resumed?.stop(); await rm(dir, { recursive: true, force: true }); });
  await dispatcher.start(); await dispatcher.submit("parent", "stable-id", "implement bridge");
  await until(() => !!store.list()[0]?.workerRetry);
  assert.equal(calls, 1); assert.equal(store.list()[0].status, "ready");
  await dispatcher.kick(); assert.equal(calls, 1, "no hot retry before due time");
  await dispatcher.stop();
  const restored = new ExecutionStore(file, { now: () => now }); await restored.load();
  resumed = new Dispatcher(restored, strategy, 1, async () => {}, () => {});
  await resumed.start(); assert.equal(calls, 1);
  now = restored.list()[0].workerRetry!.nextAt; await resumed.kick();
  await until(() => restored.list()[0].status === "completed");
  assert.equal(calls, 2); assert.equal(restored.list().length, 1);
});

for (const hold of ["manual", "cancel", "expired", "semantic", "unsafe-strategy", "policy"] as const)
test(`technical recovery preserves ${hold} hold`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-hold-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "ledger.json"), { now: () => 1000 }); await store.load();
  const task = await store.submit("parent", "r", "work", "direct", 1,
    hold === "expired" ? { taskId: "p", original: "work", depth: 0, expiresAt: 999 } : undefined);
  const claim = await store.claim(task.id);
  await store.intent(task.id, claim.token!, "effect", "unsafe");
  await store.fail(task.id, claim.token!, hold === "semantic" ? "runtime-failure" : "worker-failed");
  if (hold === "manual") await store.control(task.id, "pause");
  if (hold === "cancel") await store.control(task.id, "cancel");
  const before = store.list()[0];
  await store.retryWorker(task.id, { version: 1, replaySafe: false, reconcile: hold !== "unsafe-strategy" },
    hold === "policy" ? { name: "hold", evaluate: () => "real hold" } : undefined);
  if (hold === "semantic") {
    assert.equal(store.list()[0].status, "blocked", "no effect is replayed before independent reassessment");
    assert.ok(store.list()[0].workerRetry, "a semantic assessment hold has an automatic wake-up owner");
    assert.deepEqual(store.list()[0].intent, before.intent);
  } else if (hold === "expired") {
    assert.equal(store.list()[0].diagnosticCode, "deadline-expired");
    assert.equal(store.list()[0].workerRetry, undefined);
    assert.match(store.list()[0].recoveryReason!, /deadline expired/);
  } else if (hold === "policy") {
    assert.equal(store.list()[0].recoveryReason, "real hold");
    assert.equal(store.list()[0].workerRetry, undefined);
    assert.equal(store.list()[0].status, before.status);
  } else assert.deepEqual(store.list()[0], before);
});

test("settled steps yield scarce capacity to ready review without replay", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-fair-"));
  const store = new ExecutionStore(path.join(dir, "ledger.json")); await store.load();
  await store.submit("parent", "publisher", "publish", "sequential");
  await store.submit("parent", "review", "review", "sequential");
  const order: string[] = [];
  const dispatcher = new Dispatcher(store, { name: "sequential", version: 1, replaySafe: false, reconcile: true,
    execute: async (task, context) => {
      if (task.requestId === "publisher" && !task.checkpoint) {
        order.push("publisher-step1"); await context.checkpoint("step1-settled"); await context.yieldStep!();
      }
      order.push(task.requestId); return "done";
    } }, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(dir, { recursive: true, force: true }); }); await dispatcher.start();
  await until(() => store.list().every(task => task.status === "completed"));
  assert.deepEqual(order, ["publisher-step1", "review", "publisher"]);
});
