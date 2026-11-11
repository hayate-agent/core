import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { MaintenanceJournal } from "../src/update-maintenance.js";
import { Harness } from "../src/harness.js";
import { Dispatcher, type DispatcherStrategy } from "../src/dispatcher.js";
import { ExecutionStore, ExecutionAssessmentHold } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import { ApiChannel } from "../src/api/server.js";
import { RunRegistry } from "../src/api/runs.js";
import { StateStore } from "../src/state.js";
import { sequentialStrategy } from "../src/dispatcher-sequential.js";

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "update-maintenance-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const journal = new MaintenanceJournal(path.join(dir, "maintenance.json")); await journal.load();
  let dispatcher: Dispatcher | undefined;
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, executionStore: store,
    maintenance: { journal, blockers: () => dispatcher?.maintenanceBlockers() ?? [], flush: () => store.drain() } });
  harness.addChannel(new MemoryChannel());
  harness.onStateChange = async () => {};
  t.after(async () => { await dispatcher?.stop(); await harness.stop(0); });
  return { dir, store, journal, harness, setDispatcher(d: Dispatcher) { dispatcher = d; } };
}

test("authenticated maintenance API requires explicit mode and returns durable checkpoint proof", async t => {
  const { dir, harness } = await fixture(t);
  const key = ["fixture", "local"].join("-");
  const api = new ApiChannel({ key, host: "127.0.0.1", port: 0, agent: "fixture", runs: new RunRegistry(path.join(dir, "runs.json")),
    updateAdmission: harness, cancel: (session, id) => harness.cancel(session, id), log() {} });
  harness.addChannel(api); await harness.start();
  const url = `http://127.0.0.1:${api.address!.port}/v1/update-admission`;
  const post = (body: unknown) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await fetch(url, { method: "POST" })).status, 401);
  for (const body of [{ mode: "force" }, { mode: "maintenance" }, { mode: "maintenance", request_id: "valid", timeout_ms: -1 }])
    assert.equal((await post(body)).status, 400);
  const result = await post({ mode: "maintenance", request_id: "http-once" });
  assert.equal(result.status, 201); const receipt = await result.json() as { checkpointed: boolean; lease_id: string };
  assert.equal(receipt.checkpointed, true);
  assert.deepEqual(await (await post({ mode: "maintenance", request_id: "http-once" })).json(), receipt);
  assert.equal((await post({ mode: "maintenance", request_id: "different" })).status, 409);
  assert.equal((await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ lease_id: receipt.lease_id }) })).status, 200);
});

test("maintenance yields an active publisher at the committed receipt and resumes same authority, identity and deadline once", async t => {
  const { dir, store, journal, harness, setDispatcher } = await fixture(t);
  const entered = gate(), release = gate(); let pushes = 0, reports = 0;
  const dependency = { taskId: "original-task", original: "Publish the authorized fix, then verify", depth: 3, expiresAt: Date.now() + 600000 };
  const job = await store.submit("parent", "publish-once", "one push", "sequential", 1, dependency);
  const strategy: DispatcherStrategy = { name: "sequential", version: 1, replaySafe: false, reconcile: true,
    execute: async (task, context) => {
      if (task.checkpoint === "published") { ++reports; return "PR already merged; final report"; }
      await context.intent!("push:once", "unsafe");
      ++pushes; entered.resolve(); await release.promise;
      await context.settleIntent!("push:once", "PR receipt: merged", "published");
      await context.yieldStep!();
      assert.fail("maintenance must yield at receipt, not start another step");
    } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, error => { throw error; }, undefined, undefined, () => harness.updateFenced);
  setDispatcher(dispatcher); await dispatcher.start(); await entered.promise;
  const admission = harness.prepareUpdateAdmission("deploy-publisher", 60000, 2000);
  assert.equal(harness.updateFenced, true);
  release.resolve();
  const lease = await admission; assert.equal(lease.status, "admitted", JSON.stringify(lease));
  assert.equal(journal.get("deploy-publisher")?.phase, "checkpointed");
  assert.equal(store.list()[0].status, "ready");
  assert.equal(store.list()[0].token, undefined);
  assert.equal(store.list()[0].intent, undefined);
  assert.deepEqual(store.list()[0].dependency, dependency);
  assert.equal(store.list()[0].id, job.id);
  assert.equal(store.list()[0].restarts, 0);
  assert.equal(reports, 0); assert.equal(pushes, 1);
  await dispatcher.stop();
  // New process loads exact on-disk ledgers, not a synthetic replacement mandate.
  const loaded = new ExecutionStore(store.file); await loaded.load();
  const boot = new MaintenanceJournal(journal.file); await boot.load(); await boot.recover(); await boot.recover();
  assert.equal(boot.get("deploy-publisher")?.phase, "recovered");
  const delivered = new Set<string>(); let messages = 0;
  const next = new Dispatcher(loaded, strategy, 1, async event => { if (!delivered.has(event.id)) { delivered.add(event.id); ++messages; } }, error => { throw error; });
  try {
    await next.start(); await next.waitForExecution(job.id); await next.flushEvents();
    const once = messages; await next.kick(); await next.flushEvents();
    assert.equal(messages, once); assert.equal(pushes, 1); assert.equal(reports, 1);
    assert.equal(loaded.list()[0].id, job.id); assert.deepEqual(loaded.list()[0].dependency, dependency);
    assert.equal(loaded.list()[0].status, "completed");
    assert.ok((await readFile(path.join(dir, "executions.json"), "utf8")).includes("PR already merged"));
  } finally { await next.stop(); }
});

test("paused rollout dependency, queued jobs and settled publication reports do not require all-idle", async t => {
  const { store, harness, setDispatcher } = await fixture(t);
  const paused = await store.submit("p", "paused", "wait for rollout", "direct");
  const claim = await store.claim(paused.id); await store.ask(paused.id, claim.token!, "rollout dependency");
  const report = await store.submit("p", "report", "settled publication", "direct");
  const owned = await store.claim(report.id);
  await store.intent(report.id, owned.token!, "merge", "unsafe");
  await store.settleIntent(report.id, owned.token!, "merge", "merge receipt", "report-only");
  await store.yieldStep(report.id, owned.token!);
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false, execute: async () => { assert.fail("must not execute while fenced"); } }, 1, async () => {}, () => {}, undefined, undefined, () => harness.updateFenced);
  setDispatcher(dispatcher);
  assert.deepEqual(dispatcher.updateBlockers(), ["dispatcher work"]);
  assert.deepEqual(dispatcher.maintenanceBlockers(), []);
  const result = await harness.prepareUpdateAdmission("wait-dependency", 1000, 1000);
  assert.equal(result.status, "admitted");
  assert.equal(store.list().find(e => e.id === paused.id)?.status, "paused");
  assert.equal(store.list().find(e => e.id === report.id)?.settledEffect?.result, "merge receipt");
});

test("exact host-retained sequential report is resumable; mismatched bare intent is not", async t => {
  const { store, harness, setDispatcher } = await fixture(t);
  const task = await store.submit("p", "report-only", "verify settled publication", "sequential"); const owned = await store.claim(task.id);
  const intent = `step:${task.id}:0:simple`;
  await store.intent(task.id, owned.token!, intent, "unsafe", { model: "fixture/exact" });
  const checkpoint = JSON.stringify({ v: 1, planner: { requested: {} }, plan: [{ task: "report", role: "simple", reason: "settled", evidence: "receipt" }], outcomes: [],
    assessment: { index: 0, reply: "PR merged; final report only", tools: 1, evidence: [], attempts: 1 } });
  await store.checkpoint(task.id, owned.token!, checkpoint); await store.deferAssessment(task.id, owned.token!, Date.now() + 60000);
  const strategy = sequentialStrategy({ harness, store, roles: () => undefined, runTurn: async () => assert.fail("settled report must not rerun worker"),
    turn: () => ({ tools: 0 }), resetTurn() {} });
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {}, undefined, undefined, () => harness.updateFenced); setDispatcher(dispatcher);
  assert.deepEqual(dispatcher.maintenanceBlockers(), []);
  assert.equal((await harness.prepareUpdateAdmission("settled-report", 1000, 1000)).status, "admitted");
  assert.equal(store.list()[0].intent?.key, intent, "maintenance does not approve or clear the effect");
  const mismatched = { ...store.list()[0], intent: { key: "other-effect", replay: "unsafe" as const, route: { model: "fixture/exact" } } };
  assert.equal(strategy.decisionBoundary!(mismatched), false);
});

for (const effect of ["push", "merge"]) test(`uncertain ${effect} receipt blocks only unsafe admission, never automatically replays`, async t => {
  const { store, journal, harness, setDispatcher } = await fixture(t);
  const job = await store.submit("p", effect, effect, "opaque"); const owned = await store.claim(job.id);
  await store.intent(job.id, owned.token!, effect, "unsafe"); await store.fail(job.id, owned.token!, "worker-failed");
  const dispatcher = new Dispatcher(store, { name: "opaque", version: 1, replaySafe: false, execute: async () => assert.fail("unknown external outcome must not replay") }, 1, async () => {}, () => {});
  setDispatcher(dispatcher);
  const result = await harness.prepareUpdateAdmission(`unknown-${effect}`, 1000, 30);
  assert.equal(result.status, "busy"); assert.ok(result.blockers.some(b => b.includes("unresolved effect")));
  for (let i = 0; i < 100 && harness.updateFenced; ++i) await new Promise(r => setTimeout(r, 5));
  assert.equal(harness.updateFenced, false); assert.equal(journal.get(`unknown-${effect}`)?.phase, "failed");
  assert.equal(store.list()[0].intent?.key, effect);
});

test("maintenance cannot turn a just-settled blocked verdict into a runnable correction", async t => {
  const { store, harness, setDispatcher } = await fixture(t); const entered = gate(), release = gate();
  const job = await store.submit("p", "blocked", "wait for authorized rollout", "sequential");
  const dispatcher = new Dispatcher(store, { name: "sequential", version: 1, replaySafe: false, execute: async (_task, context) => {
    await context.intent!("report", "unsafe"); entered.resolve(); await release.promise;
    await context.settleIntent!("report", "waiting for rollout owner", "retained report");
    throw new ExecutionAssessmentHold("waiting", 2, "rollout dependency");
  } }, 1, async () => {}, error => { assert.ok(error instanceof ExecutionAssessmentHold); }, undefined, undefined, () => harness.updateFenced);
  setDispatcher(dispatcher); await dispatcher.start(); await entered.promise;
  const prepare = harness.prepareUpdateAdmission("verdict-boundary", 1000, 1000); release.resolve();
  assert.equal((await prepare).status, "admitted");
  const held = store.list().find(e => e.id === job.id)!;
  assert.equal(held.status, "paused"); assert.equal(held.assessmentHold?.state, "waiting");
  assert.equal(held.intent, undefined);
});

test("duplicate admission has one writer, stable receipt, and stale/foreign leases cannot release", async t => {
  const { harness, journal } = await fixture(t);
  const first = harness.prepareUpdateAdmission("concurrent", 60000, 1000);
  const duplicate = await harness.prepareUpdateAdmission("concurrent", 60000, 1000);
  const other = await harness.prepareUpdateAdmission("other", 60000, 1000);
  assert.equal(duplicate.status, "busy"); assert.equal(other.status, "busy");
  const lease = await first; assert.equal(lease.status, "admitted");
  const retry = await harness.prepareUpdateAdmission("concurrent", 60000, 1000);
  assert.deepEqual(retry, lease);
  assert.equal(await harness.releaseMaintenanceAdmission("foreign"), false);
  assert.equal(await harness.releaseMaintenanceAdmission(lease.lease_id!), true);
  assert.equal(journal.get("concurrent")?.phase, "released");
  assert.equal((await harness.prepareUpdateAdmission("concurrent", 60000, 1000)).status, "busy");
  assert.equal(harness.updateFenced, false);
});

test("expired lease does not renew on duplicate request and does not exhaust journal capacity", async t => {
  const { journal } = await fixture(t); let now = 1000;
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, now: () => now,
    maintenance: { journal, blockers: () => [], flush: async () => {} } }); h.onStateChange = async () => {};
  const first = await h.prepareUpdateAdmission("expired-0", 1000, 1000); now += 1001;
  assert.equal(h.updateFenced, false);
  assert.equal((await h.prepareUpdateAdmission("expired-0", 1000, 1000)).status, "busy");
  assert.equal(await h.releaseMaintenanceAdmission(first.lease_id!), false);
  for (let i = 1; i < 66; ++i) {
    assert.equal((await h.prepareUpdateAdmission(`expired-${i}`, 1000, 1000)).status, "admitted");
    now += 1001;
  }
  assert.equal(h.updateFenced, false); await h.stop(0);
});

test("stale/incompatible claim produces actionable blocker; no lock deletion or claim theft", async t => {
  const { store, harness, setDispatcher } = await fixture(t);
  const job = await store.submit("p", "stale", "retained", "gone", 19); const owned = await store.claim(job.id);
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false, execute: async () => "unused" }, 1, async () => {}, () => {});
  setDispatcher(dispatcher);
  const result = await harness.prepareUpdateAdmission("stale-check", 1000, 30);
  assert.ok(result.blockers.some(b => b.includes(`stale claim: ${job.id}`)));
  assert.equal(store.list()[0].token, owned.token);
  const loaded = new ExecutionStore(store.file); await loaded.load(); await loaded.recover(new Map());
  assert.match(loaded.list()[0].recoveryReason!, /gone@19 unavailable/);
  assert.equal(loaded.list()[0].status, "blocked");
});

for (const phase of ["preparing", "checkpointed"] as const) test(`crash ${phase}: idempotent boot recovery never replays effects or resets budgets`, async t => {
  const { journal, store } = await fixture(t);
  await journal.record({ requestId: "crash", leaseId: "old-lease", pid: 1234, at: 1, phase: "preparing" });
  if (phase === "checkpointed") await journal.record({ requestId: "crash", leaseId: "old-lease", pid: 1234, at: 2, phase });
  const job = await store.submit("p", "legacy", "authentic original", "direct");
  const owned = await store.claim(job.id); await store.fail(job.id, owned.token!, "worker-failed");
  const disk = JSON.parse(await readFile(store.file, "utf8"));
  disk.executions[0].restarts = 7; delete disk.executions[0].recoveryEnrollment;
  await writeFile(store.file, JSON.stringify(disk));
  const loaded = new ExecutionStore(store.file); await loaded.load(); await loaded.holdLegacyRecovery(); await loaded.holdLegacyRecovery();
  assert.equal(loaded.list()[0].restarts, 7); assert.equal(loaded.list()[0].recoveryEnrollment, "held-legacy");
  const boot = new MaintenanceJournal(journal.file); await boot.load(); await boot.recover();
  const once = await readFile(journal.file, "utf8"); await boot.recover(); assert.equal(await readFile(journal.file, "utf8"), once);
  assert.equal(boot.get("crash")?.phase, "recovered");
});

test("ordinary active task survives the persisted barrier and resumes once with unchanged original and deadline", async t => {
  const { dir, harness } = await fixture(t);
  const expiresAt = Date.now() + 600000;
  harness.restoreSessions([{ key: "mem:room1", replyTo: { channel: "mem", target: "room1" },
    task: { id: "original", original: "operator mandate", state: "active", next: "Verify remaining work", depth: 2, expiresAt,
      recoveryAdmission: { id: "task:original:3", depth: 3, next: "Verify remaining work", original: "operator mandate", expiresAt } } }]);
  const state = new StateStore(path.join(dir, "state.json"));
  harness.onStateChange = () => state.save({ version: 1, paused: false, busyMode: "queue", sessions: harness.snapshotSessions(), pending: harness.pendingInputs() });
  assert.equal((await harness.prepareUpdateAdmission("ordinary-restart", 60000, 1000)).status, "admitted");
  const saved = await new StateStore(state.file).load(); assert.ok(saved);
  const runtime = new FakeRuntime();
  const next = new Harness({ runtime, tickMs: 60000 }); next.addChannel(new MemoryChannel()); next.onStateChange = async () => {};
  try {
    next.restoreSessions(saved.sessions);
    await next.recoverTasks(); await next.recoverTasks();
    assert.equal(next.pendingInputs().length, 1);
    const continuation = next.pendingInputs()[0];
    assert.equal(continuation.taskId, "original"); assert.equal(continuation.continuationExpiresAt, expiresAt);
    assert.match(continuation.text, /operator mandate/);
    next.releaseRestored(); await next.drained();
    assert.equal(runtime.sessions.get("mem:room1")?.prompts.length, 1);
  } finally { await next.stop(0); }
});

test("flush failure rolls back admission while durable work remains recoverable", async t => {
  const { dir, journal } = await fixture(t);
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, maintenance: { journal, blockers: () => [], flush: async () => { throw Error("fsync failed"); } } });
  harness.onStateChange = async () => {};
  harness.restoreSessions([{ key: "mem:room1", task: { id: "same", original: "operator original", state: "active", next: "Verify receipts", depth: 2, expiresAt: Date.now() + 600000 } }]);
  const before = harness.snapshotSessions();
  await assert.rejects(harness.prepareUpdateAdmission("flush-failure", 60000, 1000), /fsync failed/);
  assert.equal(harness.updateFenced, false); assert.equal(journal.get("flush-failure")?.phase, "failed");
  assert.deepEqual(harness.snapshotSessions(), before);
  assert.equal(runtime.opened.length, 0); await harness.stop(0);
  assert.ok(dir);
});

test("hung persistence returns bounded diagnostics but retains fence until outcome is known", async t => {
  const { journal } = await fixture(t); const release = gate();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, maintenance: { journal, blockers: () => [], flush: () => release.promise } });
  harness.onStateChange = async () => {};
  const result = await harness.prepareUpdateAdmission("hung-flush", 1000, 30);
  assert.equal(result.status, "busy"); assert.ok(result.blockers.some(b => b.includes("deadline reached")));
  assert.equal(harness.updateFenced, true); assert.equal(harness.updateAdmissionStatus().status, "busy");
  release.resolve();
  for (let i = 0; i < 100 && harness.updateFenced; ++i) await new Promise(r => setTimeout(r, 5));
  assert.equal(harness.updateFenced, false); assert.equal(journal.get("hung-flush")?.phase, "failed");
  await harness.stop(0);
});
