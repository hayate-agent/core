import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { Scheduler } from "../src/scheduler.js";
import { FakeRuntime } from "./fakes.js";
import { ExecutionStore } from "../src/execution.js";
import { mkdtemp, rm, writeFile, chmod, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const job = { name: "source-check", schedule: "0 * * * *", prompt: "Inspect current source and retain pending work", deliver: "local" };
const checkpoint = { sources: [{ id: "source", locator: "configured/source", cursor: "42", observedAt: "2026-11-18T10:00:00Z" }], pending: ["uncertain action requires verification"], evidence: ["retained:42"] };
function setup(t: { after(fn: () => unknown): void }) {
  const runtime = new FakeRuntime(() => "Pending source work retained");
  const h = new Harness({ runtime, completionCheck: async () => ({ state: "waiting" }) });
  h.onStateChange = async () => {};
  t.after(() => h.stop(0));
  return { h, runtime, scheduler: new Scheduler(h, { timezone: "UTC" }) };
}

test("source admission fences script effects before execution, including concurrent and restart occurrences", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "recurring-script-")); t.after(() => rm(home, { recursive: true, force: true }));
  const script = path.join(home, "observe.sh"), marker = path.join(home, "calls");
  await writeFile(script, `#!/bin/sh\nprintf x >> '${marker}'\nsleep 0.1\nprintf evidence\n`); await chmod(script, 0o700);
  const { h, runtime } = setup(t); const scheduler = new Scheduler(h, { timezone: "UTC", scriptsDir: home });
  const source = { ...job, script: "observe.sh" };
  await Promise.all([scheduler.runJob(source), scheduler.runJob(source)]); await h.waitForSessionIdle("cron:source-check");
  await scheduler.runJob(source); await h.waitForSessionIdle("cron:source-check");
  assert.equal(await readFile(marker, "utf8"), "x", "held source never reruns pre-agent side effects");
  const restarted = setup(t); restarted.h.restoreSessions(JSON.parse(JSON.stringify(h.snapshotSessions())));
  const restored = new Scheduler(restarted.h, { timezone: "UTC", scriptsDir: home });
  await restored.runJob(source);
  assert.equal(await readFile(marker, "utf8"), "x");
  await restored.runJob(source, true); await restarted.h.waitForSessionIdle("cron:source-check");
  assert.equal(await readFile(marker, "utf8"), "xx", "explicit on-demand remains a separate authorized occurrence");
  assert.equal(runtime.sessions.get("cron:source-check")!.prompts.length, 1);
});

test("timer duplicate retains exact owner and checkpoint across serialized restart", async t => {
  const { h, runtime, scheduler } = setup(t);
  runtime.answer = () => { h.stageCronCheckpoint("cron:source-check", checkpoint); return "Pending"; };
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  const before = structuredClone(h.snapshotSessions());
  const owner = before[0].tasks![0];
  assert(owner.recurringSource);
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  assert.deepEqual(h.snapshotSessions()[0].tasks, before[0].tasks);
  assert.deepEqual(h.state("cron:source-check").cronCheckpoint, before[0].cronCheckpoint);
  assert.equal(runtime.sessions.get("cron:source-check")!.prompts.length, 1);

  const restored = setup(t);
  restored.h.restoreSessions(JSON.parse(JSON.stringify(before)));
  await restored.scheduler.runJob(job); await restored.h.waitForSessionIdle("cron:source-check");
  assert.equal(restored.runtime.opened.length, 0, "no transcript/model/effect replay for duplicate occurrence");
  assert.deepEqual(restored.h.snapshotSessions()[0].tasks, JSON.parse(JSON.stringify(before[0].tasks)));
});

test("changed configuration and explicit/operator occurrences remain independent", async t => {
  const { h, scheduler } = setup(t);
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  await scheduler.runJob({ ...job, prompt: "Inspect a changed scope" }); await h.waitForSessionIdle("cron:source-check");
  await scheduler.runJob(job, true); await h.waitForSessionIdle("cron:source-check");
  assert.equal(h.state("cron:source-check").tasks!.length, 3);
  assert.equal(h.state("cron:source-check").tasks![2].recurringSource, undefined);
  for (const id of ["human-1", "human-2"]) {
    await h.accept({ id, source: "api", sessionKey: "operator", text: job.prompt });
    await h.waitForSessionIdle("operator");
  }
  assert.equal(h.state("operator").tasks!.length, 2);
});

test("settled stop permits new configured Cron work without reviving the stopped occurrence, also after restart", async t => {
  const { h, scheduler } = setup(t);
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  await h.stopConversation("cron:source-check");
  const stopped = structuredClone(h.state("cron:source-check").tasks![0]);
  const snapshot = JSON.parse(JSON.stringify(h.snapshotSessions()));
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  assert.equal(h.state("cron:source-check").tasks!.length, 2);
  assert.deepEqual(h.state("cron:source-check").tasks![0], stopped);
  assert.notEqual(h.state("cron:source-check").tasks![1].id, stopped.id);
  const restored = setup(t); restored.h.restoreSessions(snapshot);
  await restored.scheduler.runJob(job); await restored.h.waitForSessionIdle("cron:source-check");
  assert.equal(restored.h.state("cron:source-check").tasks!.length, 2);
  assert.deepEqual(restored.h.state("cron:source-check").tasks![0], JSON.parse(JSON.stringify(stopped)));
  // The newly waiting owner still coalesces later timer wake-ups.
  await restored.scheduler.runJob(job); await restored.h.waitForSessionIdle("cron:source-check");
  assert.equal(restored.runtime.sessions.get("cron:source-check")!.prompts.length, 1);
  const second = setup(t);
  second.h.opts.completionCheck = async () => ({ state: "completed" });
  await second.scheduler.runJob(job); await second.h.waitForSessionIdle("cron:source-check");
  await second.scheduler.runJob(job); await second.h.waitForSessionIdle("cron:source-check");
  assert.equal(second.h.state("cron:source-check").tasks!.length, 2);
});

test("Matrix loop timer owns one unfinished mandate, including after restart", async t => {
  const { h } = setup(t);
  const key = "matrix:room";
  await h.controlLoop(key, { action: "set", prompt: "Inspect automation", everyMs: 60000 });
  await h.tick(); await h.waitForSessionIdle(key);
  const owner = structuredClone(h.state(key).tasks![0]);
  assert(owner.recurringSource?.startsWith("loop:"));
  const restarted = setup(t);
  restarted.h.restoreSessions(JSON.parse(JSON.stringify(h.snapshotSessions())));
  restarted.h.state(key).loop!.nextAt = 0;
  await restarted.h.tick(); await restarted.h.waitForSessionIdle(key);
  assert.deepEqual(restarted.h.state(key).tasks, JSON.parse(JSON.stringify([owner])));
  await restarted.h.runLoopNow(key, "explicit-1"); await restarted.h.waitForSessionIdle(key);
  assert.equal(restarted.h.state(key).tasks!.length, 2, "on-demand is independent");
  await restarted.h.controlLoop(key, { action: "set", prompt: "Inspect automation", everyMs: 60000 });
  await restarted.h.tick(); await restarted.h.waitForSessionIdle(key);
  assert.equal(restarted.h.state(key).tasks!.length, 3, "new source generation is not prose deduplication");
});

test("concurrent timer occurrences cannot steer duplicate work into a running owner", async t => {
  const { h, runtime, scheduler } = setup(t);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  runtime.answer = async () => { entered(); await held; return "Pending"; };
  await scheduler.runJob(job); await started;
  await scheduler.runJob(job);
  release(); await h.waitForSessionIdle("cron:source-check");
  assert.equal(h.state("cron:source-check").tasks!.length, 1);
  assert.equal(runtime.sessions.get("cron:source-check")!.prompts.length, 1);
});


test("host source ownership prevents a second core taskRef without touching historical equal prose", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "recurring-core-owner-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json"), Date.now, { enforceTaskAuthority: true });
  await store.load();
  const h = new Harness({ runtime: new FakeRuntime(() => "Held"), executionStore: store,
    taskLifecycle: { enabled: true }, completionCheck: async () => ({ state: "waiting" }) });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const key = "matrix:core-room";
  const old = { id: "independent-old", original: "Inspect automation", depth: 49, state: "blocked" as const,
    recoveryEnrollment: "held-legacy" as const };
  h.restoreSessions([{ key, tasks: [old] }]);
  await h.controlLoop(key, { action: "set", prompt: old.original, everyMs: 60000 });
  await h.tick(); await h.waitForSessionIdle(key);
  const first = structuredClone(h.state(key).tasks!.find(task => task.recurringSource)!);
  assert(first.taskRef);
  const order = structuredClone(store.coreTask(first.taskRef.id));
  h.state(key).loop!.nextAt = 0;
  await h.tick(); await h.waitForSessionIdle(key);
  assert.equal(h.state(key).tasks!.length, 2);
  assert.deepEqual(h.state(key).tasks!.find(task => task.recurringSource), first);
  assert.deepEqual(store.coreTask(first.taskRef.id), order);
  assert.deepEqual(h.state(key).tasks!.find(task => task.id === old.id), old);
});

test("completed Main turn with paused unsafe child does not release source ownership", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "recurring-owner-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const runtime = new FakeRuntime(); let h: Harness;
  runtime.answer = async (_text, key) => {
    const child = await store.submit(key, "child", "Authorized action", "direct", 1, h.dependencyCheckpoint(key));
    const claimed = await store.claim(child.id);
    await store.intent(child.id, claimed.token!, "unsafe-effect", "unsafe");
    await store.control(child.id, "pause");
    return "Main inspection finished, effect still uncertain";
  };
  h = new Harness({ runtime, executionStore: store, completionCheck: async () => ({ state: "completed" }) });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const scheduler = new Scheduler(h, { timezone: "UTC" });
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  const tasks = structuredClone(h.state("cron:source-check").tasks);
  const children = structuredClone(store.list());
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  assert.deepEqual(h.state("cron:source-check").tasks, tasks);
  assert.deepEqual(store.list(), children, "no cancellation, reassignment or unsafe replay");
  assert.equal(runtime.sessions.get("cron:source-check")!.prompts.length, 1);
  await h.stopConversation("cron:source-check");
  const stopped = structuredClone(h.snapshotSessions());
  const cancelledChildren = structuredClone(store.list());
  assert.equal(cancelledChildren[0].status, "cancelled");
  assert.equal(cancelledChildren[0].intent?.key, "unsafe-effect");
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  assert.deepEqual(h.snapshotSessions(), stopped, "stopped parent cannot release a cancelled but unsettled intent");
  assert.deepEqual(store.list(), cancelledChildren);
  const reloadedStore = new ExecutionStore(path.join(home, "executions.json")); await reloadedStore.load();
  const restored = new Harness({ runtime: new FakeRuntime(), executionStore: reloadedStore });
  restored.onStateChange = async () => {}; t.after(() => restored.stop(0)); restored.restoreSessions(stopped);
  await new Scheduler(restored, { timezone: "UTC" }).runJob(job); await restored.waitForSessionIdle("cron:source-check");
  assert.deepEqual(restored.snapshotSessions(), stopped);
});

test("stopped owner keeps pending native child custody until it settles", async t => {
  const { h, scheduler, runtime } = setup(t);
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  await h.stopConversation("cron:source-check");
  const stopped = structuredClone(h.state("cron:source-check").tasks);
  let pending = true;
  h.opts.pendingNativeSubagent = (_key, taskId) => pending && taskId === stopped![0].id;
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  assert.deepEqual(h.state("cron:source-check").tasks, stopped);
  assert.equal(runtime.sessions.get("cron:source-check")!.prompts.length, 1);
  pending = false;
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  assert.equal(h.state("cron:source-check").tasks!.length, 2);
  assert.deepEqual(h.state("cron:source-check").tasks![0], stopped![0]);
});

for (const kind of ["loop", "heartbeat"] as const) test(`settled stop leaves configured ${kind} enabled across restart`, async t => {
  const { h } = setup(t), key = `matrix:stop-${kind}`;
  if (kind === "loop") await h.controlLoop(key, { action: "set", prompt: "Inspect automation", everyMs: 60000 });
  else h.state(key).heartbeat = { prompt: "Inspect automation", everyMs: 60000, nextAt: 0, paused: false };
  await h.tick(); await h.waitForSessionIdle(key); await h.stopConversation(key);
  const stopped = structuredClone(h.state(key).tasks![0]);
  const restored = setup(t); restored.h.restoreSessions(JSON.parse(JSON.stringify(h.snapshotSessions())));
  restored.h.state(key)[kind]!.nextAt = 0;
  await restored.h.tick(); await restored.h.waitForSessionIdle(key);
  assert.deepEqual(restored.h.state(key).tasks![0], JSON.parse(JSON.stringify(stopped)));
  assert.equal(restored.h.state(key).tasks!.length, 2);
  assert.equal(restored.h.state(key)[kind]!.sourceId, h.state(key)[kind]!.sourceId);
});

for (const disposition of ["done", "unresolved"] as const) test(`stopped source retains ${disposition} order fence`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "recurring-order-fence-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const { h, scheduler, runtime } = setup(t);
  h.opts.executionStore = store; h.opts.taskLifecycle = { enabled: true };
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  await h.stopConversation("cron:source-check");
  const owner = h.state("cron:source-check").tasks![0];
  if (disposition === "done") {
    const order = store.coreTask(owner.taskRef!.id)!;
    await store.decideTask(owner.taskRef!, order.revision, "operator-close", "close", "Done, no automatic reopening");
  } else owner.taskRef = await store.enrollTask("cron:source-check", "legacy-order", owner.original, "legacy", "legacy");
  const tasks = structuredClone(h.state("cron:source-check").tasks), orders = structuredClone(store.tasks());
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:source-check");
  assert.deepEqual(h.state("cron:source-check").tasks, tasks);
  assert.deepEqual(store.tasks(), orders);
  assert.equal(runtime.sessions.get("cron:source-check")!.prompts.length, 1);
});
