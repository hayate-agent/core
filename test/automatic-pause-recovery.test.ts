import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail("recovery did not settle");
}

for (const legacy of [false, true]) for (const intent of [false, true])
test(`internal pause wakes automatically with retained identity, backoff and restart (legacy=${legacy}, intent=${intent})`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-paused-"));
  let dispatcher: Dispatcher | undefined;
  t.after(async () => { await dispatcher?.stop(); await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, "ledger.json"); let now = 1000;
  let store = new ExecutionStore(file, { now: () => now }); await store.load();
  const task = await store.submit("parent", "stable", "authorized work", "fixture");
  const claim = await store.claim(task.id);
  await store.checkpoint(task.id, claim.token!, "settled evidence");
  if (intent) await store.intent(task.id, claim.token!, "uncertain", "unsafe");
  const strategy = { name: "fixture", version: 1, replaySafe: false, reconcile: true,
    execute: async (retained: import("../src/execution.js").Execution, context: import("../src/dispatcher.js").DispatchContext) => {
      assert.equal(retained.id, task.id); assert.equal(retained.checkpoint, "settled evidence");
      if (intent) { assert.equal(retained.intent?.key, "uncertain"); await context.settleIntent("uncertain", "reconciled", "settled evidence"); }
      return "done";
    } };
  await store.fail(task.id, claim.token!, "runtime-failure", legacy ? undefined : { strategy });
  dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {}); await dispatcher.start();
  const due = store.list()[0].workerRetry!.nextAt;
  for (let i = 0; i < 10; i++) await dispatcher.kick();
  assert.equal(store.list()[0].workerRetry!.nextAt, due, "ticks do not renew backoff");
  assert.equal(store.list()[0].status, intent ? "blocked" : "paused");
  await dispatcher.stop();
  store = new ExecutionStore(file, { now: () => now }); await store.load();
  dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {}); await dispatcher.start();
  now = due - 1; await dispatcher.kick(); assert.notEqual(store.list()[0].status, "completed");
  now = due; await dispatcher.kick(); await until(() => store.list()[0].status === "completed");
  assert.equal(store.list().length, 1);
});

for (const diagnostic of ["runtime-failure", "worker-failed"] as const)
test(`task expiry clears ${diagnostic} retry even before its backoff is due`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-expired-retry-"));
  let dispatcher: Dispatcher | undefined;
  t.after(async () => { await dispatcher?.stop(); await rm(dir, { recursive: true, force: true }); });
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const store = new ExecutionStore(path.join(dir, "ledger.json"), { now: () => now }); await store.load();
  const strategy = { name: "fixture", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { assert.fail("expired work must not execute"); } };
  const task = await store.submit("parent", "r", "work", "fixture", 1, { taskId: "p", original: "work", depth: 0, expiresAt: now + 1000 });
  const claim = await store.claim(task.id); await store.fail(task.id, claim.token!, diagnostic, { strategy });
  assert.ok(store.list()[0].workerRetry!.nextAt > now + 1000);
  now += 1000; dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {}); await dispatcher.start();
  assert.equal(store.list()[0].workerRetry, undefined);
  assert.equal(store.list()[0].diagnosticCode, "deadline-expired");
  assert.equal(store.events().at(-1)?.automaticRetryAt, undefined);
});

test("ready worker retry rechecks a changed trusted recovery policy before claim", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-ready-policy-")); let dispatcher: Dispatcher | undefined;
  t.after(async () => { await dispatcher?.stop(); await rm(dir, { recursive: true, force: true }); });
  let now = 1000; const store = new ExecutionStore(path.join(dir, "ledger.json"), { now: () => now }); await store.load();
  let hold = false; let calls = 0;
  const policy = { name: "live-gate", evaluate: () => hold ? "real changed gate" : undefined };
  const strategy = { name: "fixture", version: 1, replaySafe: false, reconcile: true, execute: async () => { calls++; return "not authorized"; } };
  const task = await store.submit("parent", "r", "work", "fixture"); const claim = await store.claim(task.id);
  await store.fail(task.id, claim.token!, "worker-failed", { strategy, policy });
  dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {}, undefined, policy);
  await dispatcher.start(); now = store.list()[0].workerRetry!.nextAt; hold = true;
  await dispatcher.kick();
  assert.equal(calls, 0); assert.equal(store.list()[0].workerRetry, undefined);
  assert.equal(store.list()[0].recoveryReason, "real changed gate");
  assert.notEqual(store.list()[0].status, "ready");
});

test("internal retry ownership is cleared when a genuine hold takes over", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-hold-owner-")); t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000; const store = new ExecutionStore(path.join(dir, "ledger.json"), { now: () => now }); await store.load();
  const strategy = { version: 1, replaySafe: false, reconcile: true };
  for (const hold of ["manual", "question", "policy", "cancelled", "deadline"] as const) {
    const task = await store.submit("parent", hold, "work", "fixture"); const claim = await store.claim(task.id);
    await store.fail(task.id, claim.token!, "runtime-failure", { strategy });
    const due = store.list().find(row => row.id === task.id)!.workerRetry!.nextAt; now = due;
    if (hold === "manual") await store.control(task.id, "pause");
    else if (hold === "policy") await store.retryWorker(task.id, strategy, { name: "required-gate", evaluate: () => "real required gate" });
    else {
      await store.retryWorker(task.id, strategy); const next = await store.claim(task.id);
      if (hold === "question") await store.ask(task.id, next.token!, "Actual missing input");
      else await store.fail(task.id, next.token!, hold === "deadline" ? "deadline-expired" : "worker-cancelled");
    }
    const row = store.list().find(row => row.id === task.id)!;
    assert.equal(row.workerRetry, undefined, hold);
    assert.equal(store.events().filter(e => e.executionId === task.id).at(-1)?.automaticRetryAt, undefined, hold);
  }
});

for (const hold of ["manual-pause", "worker-cancelled", "deadline-expired", "unknown"] as const)
test(`automatic recovery never overrides ${hold}`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hy-real-hold-"));
  let dispatcher: Dispatcher | undefined;
  t.after(async () => { await dispatcher?.stop(); await rm(dir, { recursive: true, force: true }); });
  const store = new ExecutionStore(path.join(dir, "ledger.json")); await store.load();
  const task = await store.submit("parent", "stable", "work", "fixture"); const claim = await store.claim(task.id);
  if (hold === "manual-pause") await store.control(task.id, "pause");
  else if (hold !== "unknown") await store.fail(task.id, claim.token!, hold);
  else { await store.ask(task.id, claim.token!, "Need actual input"); }
  const before = store.list()[0];
  dispatcher = new Dispatcher(store, { name: "fixture", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { assert.fail("explicit hold must not execute"); } }, 1, async () => {}, () => {});
  await dispatcher.start(); for (let i = 0; i < 10; i++) await dispatcher.kick();
  assert.deepEqual(store.list()[0], before);
});
