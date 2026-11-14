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

/** Advance the controlled clock past the pending backoff, kick, and wait for the next attempt or exhaustion. */
async function nextAttempt(store: ExecutionStore, dispatcher: Dispatcher, nowRef: () => number, setNow: (value: number) => void) {
  const before = store.list()[0];
  const prev = before.workerRetry?.attempts ?? 0;
  if (before.workerRetry && before.workerRetry.nextAt > nowRef()) setNow(before.workerRetry.nextAt);
  await dispatcher.kick();
  await until(() => {
    const task = store.list()[0];
    return task.diagnosticCode === "retry-exhausted" || (task.workerRetry?.attempts ?? 0) > prev;
  });
}

test("always-failing worker is bounded by the default retry budget and holds as retry-exhausted", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-exhaust-"));
  const file = path.join(dir, "ledger.json"); let now = 1000;
  const store = new ExecutionStore(file, { now: () => now }); await store.load();
  await store.submit("parent", "boom", "always fail", "direct");
  let calls = 0;
  const strategy = { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { calls++; throw new ExecutionWorkerFailure("worker-failed"); } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(dir, { recursive: true, force: true }); });
  await dispatcher.start();
  await until(() => store.list()[0].workerRetry !== undefined);
  for (let round = 0; round < 40; round++) {
    if (store.list()[0].diagnosticCode === "retry-exhausted") break;
    await nextAttempt(store, dispatcher, () => now, value => { now = value; });
  }
  const task = store.list()[0];
  assert.equal(task.diagnosticCode, "retry-exhausted");
  assert.equal(task.status, "paused");
  assert.equal(task.workerRetry, undefined);
  assert.equal(calls, 12, "initial run + 11 retries = default budget");
  // No retry slot remains: far beyond any backoff nothing launches again.
  now += 24 * 3600 * 1000;
  await dispatcher.kick();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(calls, 12);
  assert.equal(store.list()[0].diagnosticCode, "retry-exhausted");
});

test("configurable workerRetryMax is respected (cap 2 stops after two total attempts)", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-cap-"));
  const file = path.join(dir, "ledger.json"); let now = 1000;
  // Production wiring passes a live config reader; the store must honor it.
  const store = new ExecutionStore(file, { now: () => now, workerRetryMax: () => 2 }); await store.load();
  await store.submit("parent", "boom", "always fail", "direct");
  let calls = 0;
  const strategy = { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { calls++; throw new ExecutionWorkerFailure("worker-failed"); } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(dir, { recursive: true, force: true }); });
  await dispatcher.start();
  await until(() => store.list()[0].workerRetry !== undefined);
  for (let round = 0; round < 10; round++) {
    if (store.list()[0].diagnosticCode === "retry-exhausted") break;
    await nextAttempt(store, dispatcher, () => now, value => { now = value; });
  }
  assert.equal(store.list()[0].diagnosticCode, "retry-exhausted");
  assert.equal(store.list()[0].workerRetry, undefined);
  assert.equal(calls, 2, "initial run + 1 retry = configured budget");
});

test("raising workerRetryMax live after exhaustion does not wake the hold (regression)", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-caplive-"));
  const file = path.join(dir, "ledger.json"); let now = 1000;
  // Live cap reader, as wired in src/cli.ts: the store re-reads the value for every attempt.
  let cap = 1;
  const store = new ExecutionStore(file, { now: () => now, workerRetryMax: () => cap }); await store.load();
  await store.submit("parent", "boom", "always fail", "direct");
  let calls = 0;
  const strategy = { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { calls++; throw new ExecutionWorkerFailure("worker-failed"); } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(dir, { recursive: true, force: true }); });
  await dispatcher.start();
  await until(() => store.list()[0].diagnosticCode === "retry-exhausted");
  assert.equal(store.list()[0].status, "paused");
  assert.equal(calls, 1, "cap 1: the single attempt is the initial run");
  // M1 guard: exhaustion must fully clear the retry state, not leave an {attempts: 0} remnant.
  assert.equal(store.list()[0].workerRetry, undefined);
  // Operator raises the live cap far above the exhausted budget.
  cap = 10;
  for (let round = 0; round < 3; round++) {
    now += 24 * 3600 * 1000;
    await dispatcher.kick();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(calls, 1, `kick ${round + 1} after the live cap raise must not wake the hold`);
    assert.equal(store.list()[0].status, "paused");
    assert.equal(store.list()[0].diagnosticCode, "retry-exhausted");
  }
  // Explicit resume is the manual release path: the task runs again.
  await store.control(store.list()[0].id, "resume");
  assert.equal(store.list()[0].status, "ready");
  await dispatcher.kick();
  await until(() => calls > 1 && store.list()[0].workerRetry !== undefined);
  assert.equal(calls, 2, "resume released the hold and the worker ran again");
  assert.equal(store.list()[0].workerRetry?.attempts, 1, "the counter restarted at zero after exhaustion");
});

test("mandate deadline takes priority over the retry budget", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-due-"));
  const file = path.join(dir, "ledger.json"); let now = 1000;
  const store = new ExecutionStore(file, { now: () => now }); await store.load();
  // Future in real time (the task must actually run first) and far future in the controlled clock.
  const deadline = Date.now() + 60000;
  await store.submit("parent", "due", "fixture", "direct", 1, { taskId: "p", original: "fixture", depth: 0, expiresAt: deadline });
  let calls = 0;
  const strategy = { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { calls++; throw new ExecutionWorkerFailure("worker-failed"); } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(dir, { recursive: true, force: true }); });
  await dispatcher.start();
  await until(() => store.list()[0].workerRetry !== undefined);
  assert.equal(calls, 1, "first failure still schedules a retry before the deadline");
  now = deadline + 1000;
  await dispatcher.kick();
  await until(() => store.list()[0].diagnosticCode === "deadline-expired");
  const task = store.list()[0];
  assert.equal(task.diagnosticCode, "deadline-expired", "deadline wins over retry exhaustion");
  assert.equal(task.status, "paused");
  assert.equal(task.workerRetry, undefined);
  assert.match(task.recoveryReason!, /deadline expired/);
  assert.equal(calls, 1);
});

test("empty result text is marked empty-result and stays completed", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-empty-"));
  const store = new ExecutionStore(path.join(dir, "ledger.json")); await store.load();
  await store.submit("parent", "empty", "fixture", "direct");
  await store.submit("parent", "full", "fixture", "direct");
  const delivered: import("../src/execution.js").ExecutionEvent[] = [];
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async (task) => task.requestId === "empty" ? "" : "ok" }, 1, async event => { delivered.push(event); }, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(dir, { recursive: true, force: true }); });
  await dispatcher.start();
  await until(() => store.list().every(task => task.status === "completed"));
  const empty = store.list().find(task => task.requestId === "empty")!;
  const full = store.list().find(task => task.requestId === "full")!;
  assert.equal(empty.result, "");
  assert.equal(empty.diagnosticCode, "empty-result");
  assert.equal(full.diagnosticCode, undefined);
  assert.equal(full.result, "ok");
  await dispatcher.flushEvents();
  assert.ok(delivered.some(event => event.type === "status" && /empty-result/.test(event.text)),
    "observe actual delivered evidence, not the pending queue from which ack removes events");
});

test("fail-then-succeed never reaches retry-exhausted and completes unchanged", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-flaky-"));
  const file = path.join(dir, "ledger.json"); let now = 1000;
  const store = new ExecutionStore(file, { now: () => now }); await store.load();
  await store.submit("parent", "flaky", "fixture", "direct");
  let calls = 0;
  const strategy = { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { calls++; if (calls === 1) throw new ExecutionWorkerFailure("worker-failed"); return "recovered"; } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(dir, { recursive: true, force: true }); });
  await dispatcher.start();
  await until(() => store.list()[0].workerRetry !== undefined);
  now = store.list()[0].workerRetry!.nextAt;
  await dispatcher.kick();
  await until(() => store.list()[0].status === "completed");
  const task = store.list()[0];
  assert.equal(task.result, "recovered");
  // complete() keeps the last failure diagnostic (pre-existing behavior); the regression
  // requirement is that the automatic budget is never exhausted on the recovery path.
  assert.notEqual(task.diagnosticCode, "retry-exhausted");
  assert.equal(task.workerRetry, undefined);
  assert.equal(calls, 2);
  assert.ok(!store.events().some(event => /retry-exhausted/.test(event.text)));
});
