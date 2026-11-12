import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PriorityScheduler } from "../src/task-priority.js";
import { Harness, type DurableTask } from "../src/harness.js";
import { Dispatcher, type DispatcherStrategy } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import { taskPriorityPlugin } from "../src/task-priority-plugin.js";
import { operatorPriorityIntent } from "../src/priority-intent.js";
import type { PluginAPI, PluginTool } from "../src/plugins.js";

const key = "mem:room1";
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const task = (id: string, priority: DurableTask["priority"] = "normal"): DurableTask => ({ id, original: `authorized ${id}`, state: "active", depth: 0,
  priority, next: "verify independent work", recoveryEnrollment: "current", anchor: { id, task: `authorized ${id}`, receivedAt: 1 } });
const admission = (t: DurableTask) => ({ ...t, recoveryAdmission: { id: `task:${t.id}:1`, depth: 1, original: t.original, next: t.next! } });
function restore(h: Harness, tasks: DurableTask[]) { h.addChannel(new MemoryChannel()); h.restoreSessions([{ key, replyTo: { channel: "mem", target: "room1" }, tasks, task: tasks[0] }]); h.onStateChange = async () => {}; }

test("explicit priorities prefer urgent tasks without starving the other priority classes", () => {
  const scheduler = new PriorityScheduler(), tasks = [task("low", "low"), task("normal"), task("high", "high")];
  const order = Array.from({ length: 10 }, () => scheduler.pick(tasks, t => t.id, t => t.priority)!.id);
  assert.deepEqual(order, ["high", "high", "high", "high", "low", "high", "high", "high", "high", "normal"]);
  const equal = new PriorityScheduler(); assert.deepEqual(Array.from({ length: 6 }, () => equal.pick(tasks, t => t.id, () => "normal")!.id), ["low", "normal", "high", "low", "normal", "high"]);
});

test("operator priority survives restart, directs first Main turn and never changes holds/budgets", async t => {
  const h = new Harness({ runtime: new FakeRuntime() }); t.after(() => h.stop(0));
  restore(h, [admission(task("old")), admission(task("urgent"))]);
  const stopped: DurableTask = { ...task("manual"), state: "stopped", expiresAt: 1234, depth: 7 };
  h.state(key).tasks!.push(stopped);
  await h.setTaskPriority(key, "urgent", "high"); await h.setTaskPriority(key, "manual", "high");
  const saved = h.snapshotSessions(); assert.equal(saved[0].tasks!.find(t => t.id === "manual")!.state, "stopped");
  const order: string[] = [];
  const restored = new Harness({ runtime: new FakeRuntime(() => { order.push(restored.state(key).current!.taskId!); return "verified"; }), completionCheck: async () => ({ state: "completed" }) });
  t.after(() => restored.stop(0)); restored.addChannel(new MemoryChannel()); restored.restoreSessions(saved); restored.onStateChange = async () => {};
  assert.equal(restored.taskPriority(key, "urgent"), "high");
  await restored.recoverTasks(); restored.releaseRestored(); await restored.drained();
  assert.deepEqual(order, ["urgent", "old"]);
  const manual = restored.state(key).tasks!.find(t => t.id === "manual")!;
  assert.equal(manual.state, "stopped"); assert.equal(manual.depth, 7); assert.equal(manual.expiresAt, 1234);
});

test("failed priority persistence rolls back and schedulers see only the last committed preference", async t => {
  const h = new Harness({ runtime: new FakeRuntime() }); t.after(() => h.stop(0)); restore(h, [task("A")]);
  let rejectSave!: (error: Error) => void;
  h.onStateChange = () => new Promise<void>((_resolve, reject) => { rejectSave = reject; });
  const change = h.setTaskPriority(key, "A", "high");
  assert.equal(h.taskPriority(key, "A"), "normal", "in-flight priority must not reach the live Dispatcher callback");
  rejectSave(Error("disk unavailable")); await assert.rejects(() => change, /disk unavailable/);
  assert.equal(h.taskPriority(key, "A"), "normal"); assert.equal(h.snapshotSessions()[0].tasks![0].priority, "normal");
  h.onStateChange = async () => {}; await h.setTaskPriority(key, "A", "high"); assert.equal(h.taskPriority(key, "A"), "high");
});

test("parent priority tool requires interactive operator authorization; worker prose cannot promote itself", async t => {
  const h = new Harness({ runtime: new FakeRuntime() }); t.after(() => h.stop(0)); restore(h, [task("original")]);
  let tool: PluginTool | undefined;
  await taskPriorityPlugin(h, () => false).activate({ registerTool: value => { tool = value; } } as PluginAPI);
  await assert.rejects(() => tool!.execute({ action: "set", taskId: "original", priority: "high" }, { sessionKey: key }), /Authenticated operator/);
  assert.equal(h.taskPriority(key, "original"), "normal");
  await assert.rejects(() => tool!.execute({ action: "list" }, { sessionKey: "dispatch:worker" }), /Parent coordination only/);
});

test("independent priority intent validation fails closed and receives only operator text and host task identity", async () => {
  const candidate = { id: "A", original: "Verify the installed revision" }; let prompt = "";
  assert.equal(await operatorPriorityIntent({ review: async value => { prompt = value; return '{"approved":true}'; } }, "Prioritize activation verification as high", candidate, "high"), true);
  const data = JSON.parse(prompt.split("DATA: ")[1]);
  assert.deepEqual(data, { operatorMessage: "Prioritize activation verification as high", candidateTask: candidate, requestedPriority: "high" });
  for (const response of ['{"approved":false}', '{"approved":"true"}', '{"approved":true,"other":"instruction"}', 'not JSON'])
    assert.equal(await operatorPriorityIntent({ review: async () => response }, "Discuss priorities", candidate, "high"), false);
  assert.equal(await operatorPriorityIntent({ review: async () => { throw Error("private failure"); } }, "Request", candidate, "high"), false);
  const abort = new AbortController(); abort.abort();
  assert.equal(await operatorPriorityIntent({ review: async () => { throw Error("must not call"); } }, "Request", candidate, "high", abort.signal), false);
});

test("durable queued Dispatcher requests inherit priority, overlap at capacity and preserve non-preemption", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-priority-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const started: string[] = [], releases = new Map<string, () => void>();
  const strategy: DispatcherStrategy = { name: "parallel-test", version: 1, replaySafe: true, execute: async request => {
    started.push(request.input); await new Promise<void>(resolve => releases.set(request.input, resolve)); return "verified";
  } };
  for (const [id, priority] of [["low", "low"], ["high", "high"], ["normal", "normal"]] as const)
    await store.submit(key, id, id, strategy.name, 1, { taskId: id, original: `authorized ${id}`, depth: 0, priority });
  const reloaded = new ExecutionStore(path.join(dir, "executions.json")); await reloaded.load();
  assert.equal(reloaded.list().find(t => t.input === "high")!.dependency!.priority, "high");
  const dispatcher = new Dispatcher(reloaded, strategy, 2, async () => {}, error => { throw error; }); t.after(() => { releases.forEach(release => release()); return dispatcher.stop(); });
  await dispatcher.start(); for (let i = 0; i < 20 && started.length < 2; i++) await tick();
  assert.deepEqual(started, ["high", "normal"]); assert.equal(dispatcher.workers.active, 2);
  assert.equal(started.includes("low"), false);
  releases.get("normal")!(); for (let i = 0; i < 30 && started.length < 3; i++) await tick();
  assert.deepEqual(started, ["high", "normal", "low"]); assert.equal(dispatcher.workers.active, 2, "urgent running worker was not preempted");
  releases.get("high")!(); releases.get("low")!(); await dispatcher.stop();
});

test("restart coordinates two retained parent tasks while their independent workers run simultaneously, without user nudge", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "main-dispatch-parallel-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const workers: string[] = [], releases: Array<() => void> = [];
  const strategy: DispatcherStrategy = { name: "parallel-test", version: 1, replaySafe: true, execute: async request => {
    workers.push(request.dependency!.taskId); await new Promise<void>(resolve => releases.push(resolve)); return "verified independent task";
  } };
  let dispatcher: Dispatcher;
  const h = new Harness({ executionStore: store, runtime: new FakeRuntime(async () => {
    const input = h.state(key).current!;
    await dispatcher.submit(key, `request:${input.taskId}`, `independent ${input.taskId}`, input.taskId);
    h.planContinuation(key, { state: "waiting" }); return "Delegated; awaiting this task's own child.";
  }), completionCheck: async input => input.continuationDepth ? { state: "waiting" } : { state: "continue", next: "delegate bounded independent work" } });
  t.after(() => h.stop(0)); restore(h, [task("A"), task("B")]);
  dispatcher = new Dispatcher(store, strategy, 2, async () => {}, error => { throw error; }, parent => h.dependencyCheckpoint(parent));
  t.after(() => { releases.forEach(release => release()); return dispatcher.stop(); }); await dispatcher.start();
  await h.recoverTasks(); h.releaseRestored();
  for (let i = 0; i < 50 && workers.length < 2; i++) await tick();
  assert.deepEqual(workers, ["A", "B"]); assert.equal(dispatcher.workers.active, 2);
  assert.equal(h.state(key).tasks!.find(t => t.id === "A")!.state, "waiting");
  releases.forEach(release => release()); await dispatcher.stop();
});
