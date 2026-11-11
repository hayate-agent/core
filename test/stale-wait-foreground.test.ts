import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, type DurableTask } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const DAY = 86_400_000;
const ORIGINAL = "Review-scope of PR271 / 297d139 (Nov 5 mandate)";

// Reproduces the Nov 5 task: waiting, paused runtime-failure child, wait window long over,
// and a newer operator task (the current conversation) already retained in the same session.
async function fixture(t: { after(fn: () => Promise<void>): void }, opts: { deadline: number; now: number }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stale-wait-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("mem:room1", "child", "Reconcile PR271 review", "direct", 1,
    { taskId: "old", depth: 0, original: ORIGINAL });
  const claimed = await store.claim(child.id);
  await store.intent(child.id, claimed.token!, "worktree-edit", "unsafe"); // uncertain effect: blocked, never replayed
  await store.fail(child.id, claimed.token!, "worker-failed");
  let assessments = 0;
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, executionStore: store, now: () => opts.now, tickMs: 60000,
    completionCheck: async (): Promise<any> => { assessments++; return { state: "continue", next: "Read retained result of the old worker" }; } });
  h.addChannel(new MemoryChannel());
  h.onStateChange = async () => {};
  const old: DurableTask = { id: "old", original: ORIGINAL, state: "waiting", depth: 0, next: "Check old worker",
    expiresAt: opts.deadline, // authentic task expiry, distinct from a model polling window
    anchor: { id: "a-old", task: ORIGINAL, receivedAt: opts.now - 5 * DAY },
    wait: { reason: "waiting for worker", nextAt: opts.deadline - 1000, deadline: opts.deadline } };
  const current: DurableTask = { id: "example", original: "Migrate example", state: "completed", depth: 0,
    anchor: { id: "a-new", task: "Migrate example", receivedAt: opts.now - 1000 } };
  h.restoreSessions([{ key: "mem:room1", tasks: [old, current], replyTo: { channel: "mem", target: "room1" } }]);
  t.after(() => h.stop(0));
  return { h, runtime, assessments: () => assessments, task: (id: string) => h.snapshotSessions()[0]!.tasks!.find(x => x.id === id)! };
}

test("expired wait of an old task cannot take the foreground via a stored continuation", async t => {
  const now = 10 * DAY;
  const f = await fixture(t, { now, deadline: now - 4 * DAY });
  await f.h.recoverTasks();
  assert.equal(f.assessments(), 0, "no assessment may re-admit an expired wait");
  assert.equal(f.task("old").recoveryAdmission, undefined, "no admission for the stale continuation");
  assert.equal(f.h.pendingInputs().filter(i => i.taskId === "old").length, 0);
  await f.h.tick(); await f.h.drained();
  assert.equal(f.runtime.sessions.size, 0, "no foreground turn for the stale topic");
  assert.equal(f.h.pendingInputs().filter(i => i.taskId === "old").length, 0);
  const old = f.task("old");
  assert.equal(old.original, ORIGINAL, "mandate stays immutable");
  assert.equal(old.recoveryAdmission, undefined);
  assert.notEqual(old.state, "completed"); assert.notEqual(old.state, "stopped"); // unfinished work is retained, not dropped
  assert.equal(old.next, "Check old worker");
});

test("wait inside its window still reconciles independently (background work stays valid)", async t => {
  const now = 10 * DAY;
  const f = await fixture(t, { now, deadline: now + DAY });
  await f.h.recoverTasks();
  assert.equal(f.assessments(), 1);
  assert.ok(f.task("old").recoveryAdmission?.independent);
});

test("in-window admission keeps the original mandate and queue id (authorization unchanged)", async t => {
  const now = 10 * DAY;
  const f = await fixture(t, { now, deadline: now + DAY });
  await f.h.recoverTasks();
  // Authority is unchanged: the original mandate and the admission still match.
  const old = f.task("old");
  assert.equal(old.recoveryAdmission?.original, ORIGINAL);
  assert.equal(old.recoveryAdmission?.id, "task:old:1");
});

// --- Foreground priority: active newer operator topic vs. stored continuation of an older mandate ---
async function priorityFixture(t: { after(fn: () => Promise<void>): void }, o: {
  independent: boolean; oldTags: string[]; newTags: string[]; newer?: boolean; newState?: DurableTask["state"]; oldUntagged?: boolean }) {
  const now = 10 * DAY;
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, now: () => now, tickMs: 60000 });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  const next = "Read retained result of the old worker";
  const old: DurableTask = { id: "old", original: ORIGINAL, state: "active", depth: 2, next,
    anchor: { id: "a-old", task: ORIGINAL, receivedAt: now - 5 * DAY, ...(o.oldUntagged ? {} : { outputTags: o.oldTags }) },
    recoveryAdmission: { id: "task:old:3", depth: 3, next, original: ORIGINAL,
      ...(o.independent ? { independent: { evidence: "e", taskId: "old", sessionKey: "mem:room1" } } : {}) } };
  const current: DurableTask = { id: "example", original: "Migrate example", state: o.newState ?? "active", depth: 0, // no runnable step
    anchor: { id: "a-new", task: "Migrate example", receivedAt: o.newer === false ? now - 6 * DAY : now - 1000, outputTags: o.newTags } };
  h.restoreSessions([{ key: "mem:room1", tasks: [old, current], replyTo: { channel: "mem", target: "room1" } }]);
  t.after(() => h.stop(0));
  return { h, runtime, queued: () => h.pendingInputs().filter(i => i.taskId === "old").length,
    old: () => h.snapshotSessions()[0]!.tasks!.find(x => x.id === "old")! };
}
const REVIEW = ["delivery-focus", "execution-stall"], example = ["example", "migration"];

test("stored independent continuation of an old review topic is not foreground while a newer disjoint topic is active", async t => {
  const f = await priorityFixture(t, { independent: true, oldTags: REVIEW, newTags: example });
  await f.h.recoverTasks(); await f.h.tick();
  assert.equal(f.queued(), 0); assert.equal(f.runtime.sessions.size, 0);
  const old = f.old(); // retained, not cancelled, not rewritten
  assert.equal(old.state, "active"); assert.equal(old.original, ORIGINAL);
  assert.equal(old.next, "Read retained result of the old worker"); assert.equal(old.recoveryAdmission?.independent?.taskId, "old");
});

test("same stored continuation runs when it is the newest context (background work stays valid)", async t => {
  const f = await priorityFixture(t, { independent: true, oldTags: REVIEW, newTags: example, newer: false });
  await f.h.tick();
  assert.equal(f.queued(), 1);
});

test("same-topic newer task does not defer the continuation", async t => {
  const f = await priorityFixture(t, { independent: true, oldTags: REVIEW, newTags: ["execution-stall"] });
  await f.h.tick();
  assert.equal(f.queued(), 1);
});

test("explicit operator resume admission is never deferred by newer context (no lost authorization)", async t => {
  const f = await priorityFixture(t, { independent: false, oldTags: REVIEW, newTags: example });
  await f.h.tick();
  assert.equal(f.queued(), 1);
  assert.equal(f.old().recoveryAdmission?.independent, undefined);
});

test("background continuation resumes once the newer disjoint topic is no longer active (deferred, never lost)", async t => {
  const f = await priorityFixture(t, { independent: true, oldTags: REVIEW, newTags: example, newState: "completed" });
  await f.h.tick();
  assert.equal(f.queued(), 1);
});

test("stale context without host-captured outputTags is not classified as superseded (fail open, work retained)", async t => {
  const f = await priorityFixture(t, { independent: true, oldTags: REVIEW, newTags: example, oldUntagged: true });
  await f.h.tick();
  assert.equal(f.queued(), 1);
});

test("a newer untagged mandate (scheduled/explicit, not operator ingress) never defers background work", async t => {
  const f = await priorityFixture(t, { independent: true, oldTags: REVIEW, newTags: [] });
  await f.h.tick();
  assert.equal(f.queued(), 1);
});

for (const entry of ["startup", "tick", "between-turn"] as const)
for (const fault of ["boundary", "deadline", "nextAt", "reason", "lastWait"] as const)
test(`${entry} rejects ${fault} wait before dependency admission`, async t => {
  const now = 10 * DAY;
  const f = await fixture(t, { now, deadline: now + DAY });
  const session = f.h.state("mem:room1");
  const old = session.tasks!.find(x => x.id === "old")!;
  if (fault === "boundary") { old.wait!.deadline = now; old.expiresAt = now; }
  if (fault === "deadline") old.wait!.deadline = NaN;
  if (fault === "nextAt") old.wait!.nextAt = NaN;
  if (fault === "reason") old.wait!.reason = " ";
  if (fault === "lastWait") { old.lastWait = { ...old.wait!, deadline: now }; old.expiresAt = now; old.wait = undefined; old.state = "blocked"; }
  if (entry === "startup") await f.h.recoverTasks();
  else if (entry === "tick") await f.h.tick();
  else { session.running = true; await (f.h as any).reconcileBlockedDependency(session, old, true); session.running = false; }
  assert.equal(f.assessments(), 0);
  assert.equal(old.recoveryAdmission, undefined);
  assert.equal(f.h.pendingInputs().filter(i => i.taskId === "old").length, 0);
});

for (const entry of ["startup", "tick"] as const)
test(`deferred in-window admission preserves its deadline across ${entry}`, async t => {
  const now = 10 * DAY;
  const f = await fixture(t, { now, deadline: now + DAY });
  await f.h.recoverTasks();
  const old = f.task("old");
  assert.equal(old.expiresAt, now + DAY);
  assert.equal(old.recoveryAdmission?.expiresAt, now + DAY);
  assert.equal(old.lastWait?.deadline, now + DAY);
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, now: () => now + 2 * DAY, tickMs: 60000 });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions(f.h.snapshotSessions());
  t.after(() => h.stop(0));
  if (entry === "startup") await h.recoverTasks(); else await h.tick();
  assert.equal(h.pendingInputs().filter(i => i.taskId === "old").length, 0);
  assert.equal(runtime.sessions.size, 0);
});

for (const [tool, action] of [
  ["plugin_dispatch", "submit"], ["plugin_dispatch", "status"],
  ["plugin_worker_tasks", "submit"], ["plugin_worker_tasks", "status"],
  ["plugin_subagent", "start"], ["plugin_subagent", "list"], ["plugin_subagent", "result"],
  ["plugin_loop", "status"],
]) test(`independent parent permits ${tool} ${action}`, async t => {
  const f = await priorityFixture(t, { independent: true, oldTags: REVIEW, newTags: example, newer: false });
  const s = f.h.state("mem:room1"), old = s.tasks!.find(x => x.id === "old")!;
  s.current = { id: old.recoveryAdmission!.id, taskId: old.id, sessionKey: s.key, text: "authorized step", source: "heartbeat" };
  await assert.doesNotReject(f.h.guardWaitTool(s.key, tool, { action }));
  s.current = undefined;
});
for (const [tool, action] of [
  ["plugin_dispatch", "resume"], ["plugin_dispatch", "pause"], ["plugin_dispatch", "cancel"], ["plugin_dispatch", "answer"],
  ["plugin_worker_tasks", "profile"], ["plugin_subagent", "cancel"], ["plugin_loop", "set"],
  ["plugin_dispatch", undefined],
]) test(`independent parent rejects ${tool} ${action}`, async t => {
  const f = await priorityFixture(t, { independent: true, oldTags: REVIEW, newTags: example, newer: false });
  const s = f.h.state("mem:room1"), old = s.tasks!.find(x => x.id === "old")!;
  s.current = { id: old.recoveryAdmission!.id, taskId: old.id, sessionKey: s.key, text: "authorized step", source: "heartbeat" };
  await assert.rejects(f.h.guardWaitTool(s.key, tool, { action }), /worker_orchestration_denied|Independent parent step/);
  s.current = undefined;
});
