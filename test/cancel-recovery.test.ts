import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { Subagents, type SubagentRecord } from "../src/subagents.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "api:cancel-recovery";
const turn = (id: string) => ({ id, source: "api" as const, sessionKey: key, text: `Authorized task ${id}`, replyTo: { channel: "mem", target: id } });
const wait = () => new Promise(resolve => setImmediate(resolve));

test("API stop durably revokes the retained task before abort; timer and restart never resume it", async t => {
  let checks = 0;
  const runtime = new FakeRuntime(() => "partial result");
  const h = new Harness({ runtime, completionCheck: async () => { checks++; return { state: "continue", next: "delegate remaining work" }; } });
  h.addChannel(new MemoryChannel()); const saved: unknown[] = []; h.onStateChange = async () => { saved.push(h.snapshotSessions()); };
  t.after(() => h.stop(0)); await h.sessionFor(key); runtime.sessions.get(key)!.hold();
  await h.accept(turn("original")); await wait();
  assert.equal(await h.cancel(key, "original"), "running"); await h.drained();
  assert.equal(h.state(key).tasks!.find(task => task.id === "original")!.state, "stopped");
  assert.ok(saved.some(snapshot => JSON.stringify(snapshot).includes('"state":"stopped"')));
  await h.recoverTasks(); await h.tick(); await h.drained();
  assert.equal(checks, 0, "cancellation is not an independent assessment retry");
  const restored = new Harness({ runtime: new FakeRuntime(() => { throw Error("cancelled work resumed"); }), completionCheck: async () => { throw Error("cancelled work assessed"); } });
  t.after(() => restored.stop(0)); restored.addChannel(new MemoryChannel()); restored.restoreSessions(h.snapshotSessions()); restored.onStateChange = async () => {};
  await restored.recoverTasks(); restored.releaseRestored(); await restored.tick(); await restored.drained();
  assert.equal(restored.pendingInputs().length, 0);
});

test("failed stop persistence stays locally fenced and retry cannot falsely acknowledge an unsaved stop", async t => {
  const runtime = new FakeRuntime(() => "partial"); const h = new Harness({ runtime }); h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  t.after(() => h.stop(0)); await h.sessionFor(key); runtime.sessions.get(key)!.hold(); await h.accept(turn("first")); await wait();
  h.onStateChange = async () => { throw Error("disk unavailable"); };
  await assert.rejects(() => h.cancel(key, "first"), /disk unavailable/);
  assert.equal(h.state(key).tasks!.find(task => task.id === "first")!.state, "stopped");
  assert.equal(runtime.sessions.get(key)!.aborted, 0);
  await assert.rejects(() => h.cancel(key, "first"), /disk unavailable/, "retry must not acknowledge because cancelling is already set");
  h.onStateChange = async () => {}; assert.equal(await h.cancel(key, "first"), "running"); await h.drained();
  assert.equal(runtime.sessions.get(key)!.aborted, 1);
});

test("upgrade repair accepts only exact cancelled API receipts and retains effect evidence", async t => {
  const h = new Harness({ runtime: new FakeRuntime() }); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const id = "api:run_cancelled";
  h.restoreSessions([{ key, tasks: [
    { id, original: "Original", state: "active", depth: 1, anchor: { id, task: "Original", receivedAt: 1 }, lastReply: "Effect may have committed" },
    { id: "api:run_other", original: "Other", state: "active", depth: 0, anchor: { id: "api:run_other", task: "Other", receivedAt: 1 } },
    { id: "historical", original: "Historical", state: "blocked", depth: 0 },
  ] }]);
  await h.reconcileCancelledApiTasks((session, inputId) => session === key && inputId === id);
  const tasks = h.state(key).tasks!; assert.equal(tasks[0].state, "stopped"); assert.equal(tasks[0].lastReply, "Effect may have committed");
  assert.equal(tasks[1].state, "active"); assert.equal(tasks[2].state, "blocked");
});

test("startup completes a crash after Main stop persistence before restored child owners can run", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cancel-restart-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(directory, "executions.json")); await store.load();
  const child = await store.submit(key, "old-child", "read-only probe", "direct", 1, { taskId: "stopped", original: "Original scope", depth: 0 });
  let callbacks = 0;
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, taskStopped: async () => { callbacks++; } });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  h.restoreSessions([{ key, task: { id: "stopped", original: "Original scope", state: "stopped", depth: 0, recoveryEnrollment: "current" } }]);
  await h.reconcileStoppedTasks();
  assert.equal(store.list().find(task => task.id === child.id)!.parentStopped, true);
  await h.recoverTasks(); assert.equal(callbacks, 1); assert.equal(h.pendingInputs().length, 0);
});

test("queued stop remains retryable after final save failure without consuming another queued task", async t => {
  const h = new Harness({ runtime: new FakeRuntime() }); h.addChannel(new MemoryChannel()); h.paused = true; h.onStateChange = async () => {};
  t.after(() => h.stop(0)); await h.accept(turn("queued")); await h.accept(turn("other"));
  let saves = 0; h.onStateChange = async () => { if (++saves === 2) throw Error("final save failed"); };
  await assert.rejects(() => h.cancel(key, "queued"), /final save failed/);
  assert.deepEqual(h.state(key).queue.map(input => input.id), ["queued", "other"]);
  h.onStateChange = async () => {}; assert.equal(await h.cancel(key, "queued"), "queued");
  assert.deepEqual(h.state(key).queue.map(input => input.id), ["other"]);
  assert.equal(h.state(key).tasks!.find(task => task.id === "queued")!.state, "stopped");
});

test("failed first save preserves automatic followup turn identities for durable revocation on retry", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cancel-followup-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(directory, "executions.json")); await store.load();
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store }); h.paused = true; h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  t.after(() => h.stop(0)); await h.accept(turn("queued"));
  h.state(key).queue.push({ ...turn("followup"), taskId: "queued", source: "cron", executionTurnId: "followup-ledger" });
  await store.beginTurn("followup-ledger", key); h.onStateChange = async () => { throw Error("first save failed"); };
  await assert.rejects(() => h.cancel(key, "queued"), /first save failed/);
  assert.ok(h.state(key).queue.some(input => input.id === "followup")); h.onStateChange = async () => {};
  assert.equal(await h.cancel(key, "queued"), "queued");
  assert.equal(store.turn("followup-ledger", key)!.stopped, true); assert.equal(h.state(key).queue.length, 0);
});

test("legacy subagents with unknown task ancestry receive a durable hold, never guessed cancellation", async t => {
  const h = new Harness({ runtime: new FakeRuntime() }); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const manager = new Subagents(h, async () => {});
  const base = { parent: key, handover: {} as SubagentRecord["handover"], state: "queued" as const, expiresAt: Date.now() + 60000 };
  manager.restore([{ ...base, id: "legacy", sessionKey: "subagent:legacy" }, { ...base, id: "other", parentTaskId: "different", sessionKey: "subagent:other" }]);
  await manager.cancelTaskChildren(key, "stopped-task");
  assert.equal(manager.get(key, "legacy").state, "queued"); assert.equal(manager.get(key, "legacy").ownershipHold, "unscoped-parent-stop");
  assert.throws(() => manager.beforeTurn("subagent:legacy"), /ancestry held/);
  assert.equal(manager.get(key, "other").ownershipHold, undefined); assert.equal(manager.get(key, "other").state, "queued");
  const restored = new Subagents(h, async () => {}); restored.restore(manager.snapshot());
  assert.throws(() => restored.beforeTurn("subagent:legacy"), /ancestry held/);
});

test("unscoped legacy Dispatcher work is held durably without guessing ownership; known preexisting work is unaffected", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cancel-unscoped-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(directory, "executions.json")); await store.load();
  const unknown = await store.submit(key, "unknown", "old read-only task", "direct");
  const prior = await store.submit(key, "prior", "provably predates the cancelled task", "direct");
  const completed = await store.submit(key, "completed-unknown", "retained completed effect", "direct");
  const token = (await store.claim(completed.id)).token!; await store.complete(completed.id, token, "Never replay this completed effect");
  await store.cancelTask(key, "stopped", [prior.id]);
  const completedHeld = store.list().find(task => task.id === completed.id)!;
  assert.equal(completedHeld.status, "completed"); assert.equal(completedHeld.result, "Never replay this completed effect");
  assert.equal(completedHeld.ownershipHold, "unscoped-parent-stop");
  const runtime = new DispatcherRuntime({} as never, store);
  assert.equal(runtime.resultAllowed(key, completed.id), false);
  assert.throws(() => runtime.guardResult(key, completed.id), /ancestry held/);
  const held = store.list().find(task => task.id === unknown.id)!;
  assert.equal(held.ownershipHold, "unscoped-parent-stop"); assert.equal(held.parentStopped, undefined);
  assert.equal(store.assessmentDue(held), false); assert.equal(store.list().find(task => task.id === prior.id)!.ownershipHold, undefined);
  await assert.rejects(() => store.claim(unknown.id), /not ready/);
  const restored = new ExecutionStore(path.join(directory, "executions.json")); await restored.load();
  assert.equal(restored.list().find(task => task.id === unknown.id)!.ownershipHold, "unscoped-parent-stop");
});

test("scoped stop revokes exact Dispatcher children and receipts but preserves unrelated work and uncertain effects", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cancel-task-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(directory, "executions.json")); await store.load();
  const a = await store.submit(key, "A", "A", "direct", 1, { taskId: "first", original: "A", depth: 0 });
  const b = await store.submit(key, "B", "B", "direct", 1, { taskId: "second", original: "B", depth: 0 });
  const claim = await store.claim(a.id, { strategy: "direct", version: 1, replaySafe: false, reconcile: true });
  await store.intent(a.id, claim.token!, "uncertain-effect", "unsafe");
  await store.checkpoint(a.id, claim.token!, "retained effect evidence");
  await store.cancelTask(key, "first");
  const stopped = store.list().find(task => task.id === a.id)!;
  assert.equal(stopped.status, "cancelled"); assert.equal(stopped.parentStopped, true);
  assert.equal(stopped.intent!.key, "uncertain-effect"); assert.equal(stopped.checkpoint, "retained effect evidence");
  assert.equal(store.list().find(task => task.id === b.id)!.status, "ready");
  assert.equal(store.events().some(event => event.executionId === a.id), false);
  assert.equal(store.events().some(event => event.executionId === b.id), true);
  const reloaded = new ExecutionStore(path.join(directory, "executions.json")); await reloaded.load();
  assert.equal(reloaded.list().find(task => task.id === a.id)!.parentStopped, true);
});

test("stopping one running API task preserves another accepted task in the same conversation", async t => {
  const runtime = new FakeRuntime(text => text); const h = new Harness({ runtime }); h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  t.after(() => h.stop(0)); await h.sessionFor(key); runtime.sessions.get(key)!.hold();
  await h.accept(turn("first")); await wait(); await h.accept(turn("second"));
  await h.cancel(key, "first"); await h.drained();
  assert.equal(h.state(key).tasks!.find(task => task.id === "first")!.state, "stopped");
  assert.notEqual(h.state(key).tasks!.find(task => task.id === "second")!.state, "stopped");
  assert.ok(runtime.sessions.get(key)!.prompts.some(text => text.includes("second")));
});
