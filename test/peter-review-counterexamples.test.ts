import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, type DurableTask } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "mem:room1";
const to = { channel: "mem", target: "room1" };

async function blockedChild(store: ExecutionStore, request: string, dependency?: Parameters<ExecutionStore["submit"]>[5]) {
  const child = await store.submit(key, request, `Legacy worker ${request}`, "direct", 1, dependency);
  const claim = await store.claim(child.id);
  await store.intent(child.id, claim.token!, `effect-${request}`, "unsafe");
  await store.fail(child.id, claim.token!, "worker-failed");
  return child.id;
}

function harness(store: ExecutionStore, clock: { now: number }, assess: () => Promise<unknown>, diagnostics = false) {
  let calls = 0;
  const runtime = new FakeRuntime(() => "unexpected turn");
  // Default config: technical diagnostics may be hidden; the unknown-effects blocker must not be.
  const h = new Harness({ runtime, executionStore: store, now: () => clock.now, tickMs: 60000,
    ...(diagnostics ? { gateways: { recoveryDiagnostics: true } as never } : {}),
    completionCheck: async () => { calls++; return assess() as never; } });
  h.home = to;
  const ch = new MemoryChannel(); h.addChannel(ch);
  return { h, ch, runtime, calls: () => calls };
}

test("real Peter legacy: three blocked children without dependency.taskId yield one actionable blocker, no permit, no replay over 50 ticks and restart", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "peter-unscoped-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const ids = [await blockedChild(store, "w1"), await blockedChild(store, "w2"), await blockedChild(store, "w3")];
  const before = JSON.stringify(store.list(key));
  const clock = { now: 1000 };
  // Counterexample: assessor says continue; previously this set active/independent-next-proposed
  // while hasPendingDependency fenced it forever, with no notice.
  const a = harness(store, clock, async () => ({ state: "continue", next: "Different independent parent step" }));
  let saved: ReturnType<Harness["snapshotSessions"]> = [];
  let outbox: ReturnType<Harness["outboxEntries"]> = [];
  a.h.onStateChange = async () => { saved = structuredClone(a.h.snapshotSessions()); outbox = structuredClone(a.h.outboxEntries()); };
  const proposal: DurableTask = { id: "proposal", original: "Propose an approach; implement only after approval", state: "blocked", depth: 0, expiresAt: 9000000 };
  const approval: DurableTask = { id: "approval", original: "Approved: locate the QA host; do not execute imports", state: "blocked", depth: 0,
    next: "Locate the QA host read-only", expiresAt: 9000000 };
  a.h.restoreSessions([{ key, replyTo: to, tasks: [proposal, approval] }]);
  t.after(() => a.h.stop(0));
  await a.h.recoverTasks();
  await a.h.start(); a.h.releaseRestored();
  for (let i = 0; i < 50; i++) { clock.now += 60000; await a.h.tick(); await a.h.drained(); }
  assert.equal(a.calls(), 0, "no assessment for children whose ownership is unknown");
  assert.equal(a.runtime.opened.length, 0);
  assert.equal(JSON.stringify(store.list(key)), before, "unknown children unchanged");
  const notices = a.ch.sent.filter(m => m.text.includes("ohne Aufgabenzuordnung"));
  assert.equal(notices.length, 1, JSON.stringify(a.ch.sent));
  for (const id of ids) assert.match(notices[0]!.text, new RegExp(id));
  assert.match(notices[0]!.text, /Effekte sind unbekannt/);
  assert.match(notices[0]!.text, /\/dispatch cancel/);
  for (const task of a.h.snapshotSessions()[0]!.tasks!) {
    assert.notEqual(task.state, "active");
    assert.equal(task.recoveryAdmission, undefined);
    assert.notEqual(task.supervisorDecision?.dependencyHold?.reason, "independent-next-proposed");
    assert.equal(task.expiresAt, 9000000);
  }
  // Restart from the persisted snapshot: no replayed notice, no assessment, no worker.
  await a.h.stop(0);
  const b = harness(store, clock, async () => ({ state: "continue", next: "Different independent parent step" }));
  b.h.onStateChange = async () => {};
  b.h.restoreSessions(saved); b.h.restoreOutbox(outbox);
  t.after(() => b.h.stop(0));
  await b.h.recoverTasks(); await b.h.start(); b.h.releaseRestored();
  for (let i = 0; i < 50; i++) { clock.now += 60000; await b.h.tick(); await b.h.drained(); }
  assert.equal(b.calls(), 0);
  assert.equal(b.runtime.opened.length, 0);
  assert.equal(b.ch.sent.filter(m => m.text.includes("ohne Aufgabenzuordnung")).length, 0);
  assert.equal(JSON.stringify(store.list(key)), before);
});

test("unscoped blocker also blocks a previously active task instead of leaving it queued behind the fence", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "peter-unscoped-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  await blockedChild(store, "w1");
  const clock = { now: 1000 };
  const a = harness(store, clock, async () => ({ state: "continue", next: "x" }));
  a.h.onStateChange = async () => {};
  a.h.restoreSessions([{ key, replyTo: to, tasks: [{ id: "t", original: "Do it", state: "active", depth: 1, next: "step" }] }]);
  t.after(() => a.h.stop(0));
  await a.h.recoverTasks(); await a.h.start(); a.h.releaseRestored();
  for (let i = 0; i < 5; i++) { clock.now += 60000; await a.h.tick(); await a.h.drained(); }
  assert.equal(a.h.snapshotSessions()[0]!.tasks![0]!.state, "blocked");
  assert.equal(a.ch.sent.filter(m => m.text.includes("ohne Aufgabenzuordnung")).length, 1);
  assert.equal(a.runtime.opened.length, 0);
  assert.equal(a.calls(), 0);
});

test("third technical error at 60s spacing is terminal: persisted, one distinct exhausted notice, reset path usable, deadline not extended", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "peter-exhausted-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const original = "Approved: locate the QA host; do not execute imports";
  await blockedChild(store, "child", { taskId: "parent", depth: 0, original });
  const before = JSON.stringify(store.list(key));
  const clock = { now: 1000 };
  let assess: () => Promise<unknown> = async () => { throw Error("backend unavailable"); };
  let a = harness(store, clock, () => assess(), true);
  let saved: ReturnType<Harness["snapshotSessions"]> = [];
  const persist = (h: Harness) => { h.onStateChange = async () => { saved = JSON.parse(JSON.stringify(h.snapshotSessions())); }; };
  persist(a.h);
  a.h.restoreSessions([{ key, replyTo: to, tasks: [{ id: "parent", original, state: "blocked", depth: 0, expiresAt: 5000000 }] }]);
  t.after(() => a.h.stop(0));
  const attempts: number[] = [];
  for (let i = 0; i < 3; i++) {
    // Restart before every attempt: the retry budget must survive persistence.
    await a.h.stop(0);
    a = harness(store, clock, () => assess(), true); persist(a.h); a.h.restoreSessions(structuredClone(saved.length ? saved :
      [{ key, replyTo: to, tasks: [{ id: "parent", original, state: "blocked", depth: 0, expiresAt: 5000000 }] }]));
    t.after(() => a.h.stop(0));
    await a.h.recoverTasks(); await a.h.recoverTasks(); // second call within 60s must not assess
    attempts.push(a.calls());
    clock.now += 60000;
  }
  assert.deepEqual(attempts, [1, 1, 1]);
  const task = saved[0]!.tasks![0]!;
  assert.equal(task.recoveryRetry?.attempts, 3);
  assert.equal(task.state, "blocked");
  assert.equal(task.termination, "recovery_assessment_failed");
  assert.equal(task.expiresAt, 5000000);
  await a.h.start(); a.h.releaseRestored();
  for (let i = 0; i < 20; i++) { clock.now += 60000; await a.h.tick(); await a.h.drained(); await a.h.recoverTasks(); }
  assert.equal(a.calls(), 1, "no fourth assessment");
  const exhausted = a.ch.sent.filter(m => m.text.includes("ausgeschöpft"));
  assert.equal(exhausted.length, 1);
  assert.match(exhausted[0]!.text, /Budget-Reset/);
  assert.match(String(exhausted[0]!.meta?.deliveryId), /^task-recovery-exhausted:/);
  assert.equal(a.runtime.opened.length, 0);
  assert.equal(JSON.stringify(store.list(key)), before);

  // Reset path: previously rejected because termination stayed undefined.
  const { token } = a.h.taskBudgetStatus(key, "parent");
  assert.match(await a.h.controlTaskBudget(key, "parent", "reset-resume", token, "req1", "mem:owner"), /^Committed/);
  const reset = a.h.snapshotSessions()[0]!.tasks![0]!;
  assert.equal(reset.recoveryRetry, undefined);
  assert.equal(reset.termination, undefined);
  assert.equal(reset.expiresAt, 5000000, "reset does not extend the deadline");
  assess = async () => ({ state: "continue", next: "Check a different read-only host inventory", expiresAt: 9000000 });
  await a.h.recoverTasks();
  assert.equal(a.calls(), 2, "exactly one new bounded assessment after reset");
  // A proposal beyond the original deadline is not admitted.
  assert.equal(a.h.snapshotSessions()[0]!.tasks![0]!.expiresAt, 5000000);
  assert.equal(a.h.snapshotSessions()[0]!.tasks![0]!.recoveryAdmission?.independent, undefined);
  assert.equal(JSON.stringify(store.list(key)), before);
});
