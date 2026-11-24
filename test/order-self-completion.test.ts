import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";
import { enrollTask, evidenceClose, commitTaskOutcome, laterOperatorInput, operatorTransition, taskOpen, type TaskBook, type TaskTodo } from "../src/task-lifecycle.js";

async function storeFixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), "order-self-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json"), { now: () => Date.now() }); await store.load();
  return store;
}
const todo = (id: string, title: string, status: TaskTodo["status"] = "running", outcome?: string): TaskTodo =>
  ({ id, title, kind: "work", status, sourceId: "op", ...(outcome ? { outcome } : {}) });

test("evidence closure is distinct from operator closure, idempotent, never for schedules, and reopenable", () => {
  const book: TaskBook = { tasks: [], bindings: [] };
  const ref = enrollTask(book, { sessionKey: "room", taskId: "op" }, "Move all open sprint tickets", "op", "operator", 1000);
  assert.equal(evidenceClose(book, ref, 1, "ec:1", "All tickets are in the new sprint", 1100), true);
  assert.equal(taskOpen(book, ref), false);
  const task = book.tasks[0];
  assert.equal(task.receipts.at(-1)!.kind, "evidence-close"); assert.equal(task.technical.state, "completed");
  assert.equal(evidenceClose(book, ref, 2, "ec:1", "again", 1200), false, "idempotent by event id");
  const reopened = operatorTransition(book, ref, 2, "human", "reopen", "Not done yet", 1300);
  assert.equal(taskOpen(book, reopened), true);
  const sched = enrollTask(book, { sessionKey: "cron:x", taskId: "s" }, "Daily report", "s", "schedule", 1000);
  assert.equal(evidenceClose(book, sched, 1, "ec:s", "done", 1100), false, "schedule occurrences keep their own lifecycle");
  assert.equal(evidenceClose(book, reopened, 1, "ec:stale", "x", 1400), false, "stale revision never closes");
});

test("an unfinished todo cannot be retitled as a rolling cursor", () => {
  const book: TaskBook = { tasks: [], bindings: [] };
  const ref = enrollTask(book, { sessionKey: "room", taskId: "op" }, "Reconcile TEST board", "op", "operator", 1000);
  commitTaskOutcome(book, { ref, expectedRevision: 1, eventId: "t1", technical: { state: "open" }, plan: [todo("test", "TEST-266 abgleichen")] }, 1100);
  assert.throws(() => commitTaskOutcome(book, { ref, expectedRevision: 2, eventId: "t2", technical: { state: "open" }, plan: [todo("test", "TEST-267 abgleichen")] }, 1200), /keep their title/);
  commitTaskOutcome(book, { ref, expectedRevision: 2, eventId: "t3", technical: { state: "open" },
    plan: [todo("test", "TEST-266 abgleichen", "done", "linked to SD-7109"), todo("test-267", "TEST-267 abgleichen")] }, 1300);
  assert.equal(book.tasks[0].plan!.length, 2);
});

test("later operator messages of the same conversation are evidence for older orders", () => {
  const book: TaskBook = { tasks: [], bindings: [] };
  const old = enrollTask(book, { sessionKey: "room", taskId: "a" }, "Carry over all To Do tickets", "a", "operator", 1000);
  enrollTask(book, { sessionKey: "other", taskId: "x" }, "Unrelated room", "x", "operator", 3000);
  enrollTask(book, { sessionKey: "room", taskId: "b" }, "The sprint is already started", "b", "operator", 2000);
  assert.deepEqual(laterOperatorInput(book, "room", old).map(m => m.text), ["The sprint is already started"]);
});

test("an independently completed foreground turn closes its order without an extra notice", async t => {
  const store = await storeFixture(t);
  let calls = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => "All To Do tickets are already in the new sprint; nothing left."), executionStore: store,
    taskLifecycle: { enabled: true }, completionCheck: async () => (calls++, { state: "completed" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await h.submit({ ...msg("Carry over all To Do tickets"), id: "op" }); await h.drained();
  assert.ok(calls >= 1);
  const order = store.tasks()[0];
  assert.equal(order.operatorStatus, "done");
  assert.equal(order.receipts.at(-1)!.kind, "evidence-close");
  assert.equal(channel.sent.filter(s => s.text.includes("/orders reopen")).length, 0, "the reply itself is the single message");
});

test("a retained background order assessed as completed closes with exactly one notice and no reminders", async t => {
  const store = await storeFixture(t);
  let calls = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => "must not run"), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => (calls++, { state: "completed" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over all To Do tickets", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over all To Do tickets", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "Operator started the sprint; all To Do tickets are in it.",
    anchor: { id: "order", task: "Carry over all To Do tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.tick(); await h.drained(); await h.tick(); await h.drained();
  assert.ok(calls >= 1);
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "done");
  assert.equal(store.coreTask(ref.id)!.receipts.at(-1)!.kind, "evidence-close");
  assert.equal(channel.sent.filter(s => s.text.includes("/orders reopen")).length, 1, "exactly one closure notice");
  await h.tick(); await h.drained();
  assert.equal(channel.sent.filter(s => s.text.includes("/orders reopen")).length, 1, "no reminders");
});

test("a self-reported completion WITHOUT independent confirmation never closes the order", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "Done."), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "continue", next: "Verify the remaining tickets" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await h.submit({ ...msg("Carry over all tickets"), id: "op" }); await h.drained();
  const order = store.tasks()[0];
  assert.equal(order.operatorStatus, "open");
  assert.ok(!order.receipts.some(r => r.kind === "evidence-close"));
});

test("new operator input withdraws other orders' admitted continuations for a read-only recheck", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(t2 => (seen.push(t2), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async input => input.taskId === "old"
      ? (input.completionContext?.retained?.order?.laterOperatorMessagesSameConversation?.some(m => /already started/.test(m.text)) ? { state: "completed" } : { state: "continue", next: "keep going" })
      : { state: "completed" } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan and start the sprint", "old", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Plan and start the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going", lastReply: "Sprint planned; TEST board reconciliation in progress.",
    recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan and start the sprint" },
    anchor: { id: "old", task: "Plan and start the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  h["paused"] = true; // keep the admitted continuation from running before the operator message
  await h.submit({ ...msg("The sprint is already started by me."), id: "new" });
  h.resume(); await h.drained(); await h.tick(); await h.drained();
  assert.ok(!seen.some(text => text.startsWith("Resume the explicitly authorized task") || text.startsWith("Continue the explicitly authorized task")),
    "the stale admitted continuation of the old order did not run as work");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "done");
});

test("an operator change during the assessment refuses closure; a refused closure keeps the order recoverable", async t => {
  const store = await storeFixture(t);
  let ref!: import("../src/task-lifecycle.js").TaskRef;
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => {
      // Operator clarifies the order while the verdict is being computed.
      await store.decideTask(ref, store.coreTask(ref.id)!.revision, "clarify-1", "clarify", "Also move the bugs");
      return { state: "completed" };
    } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  ref = await store.enrollTask("mem:room1", "order", "Carry over all To Do tickets", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over all To Do tickets", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "All To Do tickets moved.",
    anchor: { id: "order", task: "Carry over all To Do tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.tick(); await h.drained();
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open", "amended order is not closed by a stale verdict");
  assert.ok(!store.coreTask(ref.id)!.receipts.some(r => r.kind === "evidence-close"));
  assert.equal(channel.sent.filter(s => s.text.includes("/orders reopen")).length, 0);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  assert.equal(task.state, "active"); assert.ok(task.recoveryRetry, "reassessment owner retained for the amended order");
});

test("a refused foreground closure keeps the still-open order recoverable instead of completed", async t => {
  const store = await storeFixture(t);
  let h!: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => "Moved all tickets."), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async input => {
      await store.decideTask(input.taskRef!, store.coreTask(input.taskRef!.id)!.revision, "clarify-2", "clarify", "Also move the bugs");
      return { state: "completed" };
    } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await h.submit({ ...msg("Carry over all To Do tickets"), id: "op" }); await h.drained();
  const order = store.tasks()[0];
  assert.equal(order.operatorStatus, "open");
  assert.ok(!order.receipts.some(r => r.kind === "evidence-close"));
  const s = h.sessions.get("mem:room1")!;
  const task = h["tasks"](s).find((item: { id: string }) => item.id === "op");
  assert.ok(task, "the durable task is retained");
  assert.equal(task.state, "active", "open order stays recoverable");
  assert.ok(task.recoveryRetry && task.recoveryAssessment === "claimed", "a bounded read-only reassessment owner is retained");
  assert.equal(task.recoveryAdmission, undefined, "no work admitted by a refused closure");
});

test("open todos are only overridden by later operator input the verdict actually saw", async t => {
  const store = await storeFixture(t);
  let ref!: import("../src/task-lifecycle.js").TaskRef;
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async input => {
      assert.equal(input.completionContext?.retained?.order?.laterOperatorMessagesSameConversation, undefined, "verdict saw no later message");
      // A sibling operator message lands after the evidence snapshot, without changing this order's revision.
      await store.enrollTask("mem:room1", "late", "Sprint already started", "late", "operator");
      return { state: "completed" };
    } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  ref = await store.enrollTask("mem:room1", "order", "Reconcile TEST board", "order", "operator");
  await store.beginTurn("plan", "mem:room1");
  await store.settleTurn("plan", "mem:room1", { consumed: [], outbox: [], taskOutcome: { ref, expectedRevision: 1, eventId: "plan", technical: { state: "open" },
    plan: [{ id: "t", title: "TEST-266", kind: "work", status: "running", sourceId: "order" }] } });
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Reconcile TEST board", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "TEST-266 reconciled.", anchor: { id: "order", task: "Reconcile TEST board", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.tick(); await h.drained();
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open", "an unassessed later message cannot bypass open todos");
});

test("a completed verdict refused only by open todos keeps a reassessment owner (not a dead wait)", async t => {
  const store = await storeFixture(t);
  let h!: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => {
      const input = h.sessions.get("mem:room1")!.current!;
      h.proposeTaskPlan("mem:room1", [{ id: "t", title: "TEST-266", kind: "work", status: "running", sourceId: store.tasks()[0].sources[0].id }]);
      void input; return "TEST-266 reconciled.";
    }), executionStore: store, taskLifecycle: { enabled: true }, completionCheck: async () => ({ state: "completed" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await h.submit({ ...msg("Reconcile TEST board"), id: "op" }); await h.drained();
  assert.equal(store.tasks()[0].operatorStatus, "open");
  const task = h["tasks"](h.sessions.get("mem:room1")!).find((item: { id: string }) => item.id === "op");
  assert.equal(task.state, "active"); assert.ok(task.recoveryRetry, "bounded read-only reassessment owner retained");
});

test("API operator input also withdraws other orders' stale admitted continuations", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "operator input pending" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going",
    recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: store.operatorMark("mem:room1") },
    anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  h["paused"] = true;
  await h.submit({ ...msg("The sprint is already started."), source: "api", id: "api-1", replyTo: { channel: "api", target: "run-1" } });
  h.resume();
  // The API run stays held for its caller; bound the wait instead of draining it.
  const settle = () => Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  await settle(); await h.tick(); await settle();
  assert.ok(seen.some(text => text.includes("already started")), "the API turn ran");
  assert.ok(!seen.some(text => /Resume the explicitly authorized task/.test(text)), "stale continuation withdrawn after API input");
});

test("a crash after the durable evidence close still delivers exactly the one owed notice", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over all To Do tickets", "order", "operator");
  // Durable close happened; the process died before the session checkpoint.
  assert.equal(await store.closeTaskByEvidence(ref, 1, "evidence-close:n:assessment:order:1:1", "All moved"), true);
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over all To Do tickets", state: "active", depth: 1,
    recoveryEnrollment: "current", anchor: { id: "order", task: "Carry over all To Do tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.tick(); await h.drained(); await h.tick(); await h.drained();
  assert.equal(channel.sent.filter(s => s.text.includes("/orders reopen")).length, 1);
  assert.equal(h["tasks"](h.sessions.get("mem:room1")!).find((item: { id: string }) => item.id === "order").state, "completed");
});

test("the closing guard runs inside the ledger mutation: live child work arriving late refuses closure", async t => {
  const store = await storeFixture(t);
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  assert.equal(await store.closeTaskByEvidence(ref, 1, "evidence-close:q:x", "done", () => false), false);
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open");
});

test("an admitted continuation never runs once newer operator input exists than its assessment saw", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "operator input pending" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going",
    recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: store.operatorMark("mem:room1") },
    anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  // The operator writes in the same conversation (a separate order) — even if that turn never settles.
  await store.enrollTask("mem:room1", "new", "The sprint is already started", "new", "operator");
  await h.tick(); await h.drained();
  assert.ok(!seen.some(text => /Resume the explicitly authorized task/.test(text)), "stale admitted continuation was withdrawn");
});

test("same-millisecond operator input is still later evidence and still voids admissions", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "order-same-ms-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json"), { now: () => 5000 }); await store.load();
  const old = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  const mark = store.operatorMark("mem:room1");
  await store.enrollTask("mem:room1", "new", "Sprint already started", "new", "operator");
  assert.notEqual(store.operatorMark("mem:room1"), mark, "identity watermark changes at equal timestamps");
  assert.deepEqual(store.laterOperatorInput("mem:room1", old).map(m => m.text), ["Sprint already started"]);
});

test("a pre-upgrade admission without watermark fails closed once later operator input exists", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "operator input pending" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  await store.enrollTask("mem:room1", "new", "The sprint is already started", "new", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going", recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan the sprint" },
    anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.tick(); await h.drained();
  assert.ok(!seen.some(text => /Resume the explicitly authorized task/.test(text)), "legacy unmarked continuation withdrawn");
});

test("later operator input that was cut or omitted marks truncation and blocks self-closure", async t => {
  const store = await storeFixture(t);
  const old = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  await store.enrollTask("mem:room1", "long", "x".repeat(2500), "long", "operator");
  const later = store.laterOperatorInput("mem:room1", old);
  assert.equal(later[0].truncated, true);
  for (let i = 0; i < 5; i++) await store.enrollTask("mem:room1", `m${i}`, `message ${i} ` + "y".repeat(1900), `m${i}`, "operator");
  const bounded = store.laterOperatorInput("mem:room1", old);
  assert.equal(bounded.length, 4); assert.equal(bounded[0].truncated, true, "omitted older later messages are signalled");
  let h!: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true }, completionCheck: async () => ({ state: "completed" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: old, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "Sprint planned.", anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.tick(); await h.drained();
  assert.equal(store.coreTask(old.id)!.operatorStatus, "open", "incompletely assessed later input never closes");
});

test("cut later input never stands in for the order's own open todos either", async t => {
  const store = await storeFixture(t);
  const old = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  await store.beginTurn("plan", "mem:room1");
  await store.settleTurn("plan", "mem:room1", { consumed: [], outbox: [], taskOutcome: { ref: old, expectedRevision: 1, eventId: "plan", technical: { state: "open" },
    plan: [{ id: "t", title: "TEST-266", kind: "work", status: "running", sourceId: "old" }] } });
  for (let i = 0; i < 5; i++) await store.enrollTask("mem:room1", `m${i}`, `message ${i} ` + "y".repeat(1900), `m${i}`, "operator");
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: old, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "Planned.", anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "old");
  const later = store.laterOperatorInput("mem:room1", old); assert.ok(later[0].truncated);
  assert.equal(await h["closeOrderByEvidence"](s, task, "e1", "Planned", true, store.coreTask(old.id)!.revision, later, store.operatorMark("mem:room1")), "refused");
});

test("many stalled orders of one conversation ask at most one question until the operator answers", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const refs = [] as Awaited<ReturnType<typeof store.enrollTask>>[];
  for (let i = 0; i < 4; i++) refs.push(await store.enrollTask("mem:room1", `o${i}`, `Order ${i}`, `o${i}`, "operator"));
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: refs.map((ref, i) => ({ id: `o${i}`, taskRef: ref, original: `Order ${i}`, state: "active" as const, depth: 1,
    recoveryEnrollment: "current" as const, anchor: { id: `o${i}`, task: `Order ${i}`, receivedAt: 1, replyTo: ROOM } })) }]);
  const s = h.sessions.get("mem:room1")!;
  for (const task of h["tasks"](s)) for (let i = 0; i < 3; i++) h["retainForReassessment"](task, s);
  assert.ok(h["tasks"](s).every((task: { state: string }) => task.state === "blocked"), "all paused");
  assert.equal(s.outbox.filter(entry => entry.id.startsWith("evidence-stalled:")).length, 1, "one question for the conversation, not one per order");
  // The operator answers: every paused order is re-armed; a later stall may ask once again.
  h["recheckOrdersAfterOperatorInput"](s);
  const rearmed = h["tasks"](s).filter((task: { state: string }) => task.state === "active");
  assert.equal(rearmed.length, 4);
  for (let i = 0; i < 3; i++) h["retainForReassessment"](rearmed[1], s);
  assert.equal(s.outbox.filter(entry => entry.id.startsWith("evidence-stalled:")).length, 2, "an unasked order may ask after the answer");
  for (let i = 0; i < 3; i++) h["retainForReassessment"](rearmed[0], s);
  assert.equal(s.outbox.filter(entry => entry.id.startsWith("evidence-stalled:")).length, 2, "never twice per order generation");
});

test("a stalled question from a pre-marker checkpoint still counts as the conversation's open question", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const a = await store.enrollTask("mem:room1", "a", "Order A", "a", "operator"), b = await store.enrollTask("mem:room1", "b", "Order B", "b", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [
    { id: "a", taskRef: a, original: "Order A", state: "blocked", depth: 1, recoveryEnrollment: "current", evidenceStalled: true, evidenceQuestion: a.generation,
      recoveryAttentionId: "task-recovery:mem:room1:a", anchor: { id: "a", task: "Order A", receivedAt: 1, replyTo: ROOM } },
    { id: "b", taskRef: b, original: "Order B", state: "active", depth: 1, recoveryEnrollment: "current", anchor: { id: "b", task: "Order B", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "b");
  for (let i = 0; i < 3; i++) h["retainForReassessment"](task, s);
  assert.equal(task.state, "blocked");
  assert.equal(s.outbox.filter(entry => entry.id.startsWith("evidence-stalled:")).length, 0, "no second question while the first is unanswered");
});

test("a pre-upgrade completed verdict whose order stayed technically open is reassessed for closure only", async t => {
  const store = await storeFixture(t);
  const seen: string[] = []; let checks = 0;
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "unused")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => (checks++, { state: "completed" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  await store.beginTurn("turn-1", "mem:room1");
  await store.settleTurn("turn-1", "mem:room1", { consumed: [], outbox: [], taskOutcome: { ref, expectedRevision: 1, eventId: "turn-1", technical: { state: "open", evidence: "Moved." } } });
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "completed", depth: 1,
    supervisorDecision: { verdict: "completed" }, recoveryEnrollment: "current", lastReply: "Moved.", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.recoverTasks();
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  assert.ok(task.recoveryRetry && task.closureOnly, "closure-only owner for a final result");
  task.recoveryRetry.nextAt = 0;
  for (let i = 0; i < 5 && store.coreTask(ref.id)!.operatorStatus === "open"; i++) {
    await h["pump"](s); await h.tick(); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 300))]); await store.quiesce();
  }
  assert.equal(seen.length, 0, "no work");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "done");
});

test("a busy conversation (dozens of later messages) is assessed in full and a finished order closes", async t => {
  const store = await storeFixture(t);
  const old = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  for (let i = 0; i < 34; i++) await store.enrollTask("mem:room1", `m${i}`, `operator message ${i}: ` + "z".repeat(200), `m${i}`, "operator");
  const later = store.laterOperatorInput("mem:room1", old);
  assert.equal(later.length, 34); assert.ok(!later.some(item => item.truncated), "nothing cut");
  let seenLater = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async input => (seenLater = input.completionContext?.retained?.order?.laterOperatorMessagesSameConversation?.length ?? 0, { state: "completed" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: old, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "Sprint planned.", anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.tick(); await h.drained();
  assert.equal(seenLater, 34, "the verdict saw every later message");
  assert.equal(store.coreTask(old.id)!.operatorStatus, "done");
});

test("an accepted but unprocessed operator message fences an already queued continuation", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "operator input pending" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going",
    recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: store.operatorMark("mem:room1") },
    anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  // The admitted continuation is already queued ahead of a just-accepted operator message.
  s.queue.push({ id: "old:2", source: "cron", sessionKey: "mem:room1", taskId: "old", continuationDepth: 2, replyTo: ROOM,
    text: "Resume the explicitly authorized task after an interruption.\\nOriginal task:\\nPlan the sprint\\nHistorical suggested next step:\\nkeep going" });
  // Accepted, durable, but not yet processable (topic labeling retry pending): foreground
  // priority cannot move it ahead, so the continuation would otherwise run first.
  s.queue.push({ ...msg("Stop, the sprint is already started."), id: "op-new", topicPending: { attempts: 1, nextAt: Date.now() + 3600000 } });
  h["pump"](s); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  assert.ok(!seen.some(text => /Resume the explicitly authorized task/.test(text)), "continuation did not run ahead of the operator message");
});

test("operator input accepted during the assessment (not yet ledgered) refuses the closure", async t => {
  const store = await storeFixture(t);
  let h!: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => {
      h.sessions.get("mem:room1")!.queue.push({ ...msg("Also move the bugs!"), id: "op-late", topicPending: { attempts: 1, nextAt: Date.now() + 3600000 } });
      return { state: "completed" };
    } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over all To Do tickets", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over all To Do tickets", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "All To Do tickets moved.", anchor: { id: "order", task: "Carry over all To Do tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.tick(); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open", "stale verdict cannot close past accepted operator input");
});

test("repeatedly refused closures back off and then ask exactly once", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Reconcile TEST board", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Reconcile TEST board", state: "active", depth: 1,
    recoveryEnrollment: "current", anchor: { id: "order", task: "Reconcile TEST board", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  const delays: number[] = [];
  for (let i = 0; i < 2; i++) { h["retainForReassessment"](task, s); delays.push(task.recoveryRetry.nextAt - Date.now()); }
  assert.ok(delays[1] > delays[0], "exponential backoff");
  assert.notEqual(task.state, "blocked", "two refusals still back off");
  h["retainForReassessment"](task, s); // third refusal: one question, paused
  assert.equal(task.state, "blocked");
  h["retainForReassessment"](task, s); h["retainForReassessment"](task, s);
  assert.equal(task.state, "blocked"); assert.equal(task.recoveryRetry, undefined);
  assert.equal(s.outbox.filter(entry => entry.id === `evidence-stalled:${ref.id}:${ref.generation}`).length, 1, "exactly one question");
});

test("the closing guard refuses while accepted operator input is still pending (queued or steered)", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over all To Do tickets", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over all To Do tickets", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "All moved.", anchor: { id: "order", task: "Carry over all To Do tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  (s.steered ??= []).push({ ...msg("Also move the bugs!"), id: "op-late" });
  assert.equal(await h["closeOrderByEvidence"](s, task, "e1", "All moved", true, 1, undefined, store.operatorMark("mem:room1")), "refused");
  s.steered = []; s.queue.push({ ...msg("Also move the bugs!"), id: "op-late-2", topicPending: { attempts: 1, nextAt: Date.now() + 3600000 } });
  assert.equal(await h["closeOrderByEvidence"](s, task, "e2", "All moved", true, 1, undefined, store.operatorMark("mem:room1")), "refused");
  s.queue = [];
  assert.equal(await h["closeOrderByEvidence"](s, task, "e3", "All moved", true, 1, undefined, store.operatorMark("mem:room1")), "closed");
});

test("real reassessments of a refused closure escalate: backoff, then one question, then silence", async t => {
  const store = await storeFixture(t);
  let calls = 0, now = 1_000_000;
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true }, now: () => now,
    completionCheck: async () => (calls++, { state: "completed" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Reconcile TEST board", "order", "operator");
  await store.beginTurn("plan", "mem:room1");
  await store.settleTurn("plan", "mem:room1", { consumed: [], outbox: [], taskOutcome: { ref, expectedRevision: 1, eventId: "plan", technical: { state: "open" },
    plan: [{ id: "t", title: "TEST-266", kind: "work", status: "running", sourceId: "order" }] } });
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Reconcile TEST board", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "TEST-266 reconciled.", anchor: { id: "order", task: "Reconcile TEST board", receivedAt: 1, replyTo: ROOM } }] }]);
  for (let i = 0; i < 12; i++) { now += 3_700_000; await h.tick(); await h.drained(); }
  const task = h["tasks"](h.sessions.get("mem:room1")!).find((item: { id: string }) => item.id === "order");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open", "open todos without later input never close");
  assert.equal(task.state, "blocked", "paused after the bounded attempts");
  assert.ok(calls >= 3 && calls <= 5, `bounded reassessments (${calls})`);
  assert.equal(channel.sent.filter(m => m.text.includes("/orders done")).length, 1, "exactly one question");
});

// Full turn-settlement path (not the guard in isolation): two independent fences hold —
// steered operator input voids the turn's completion evidence, and settlement refuses closure.
test("a foreground turn that absorbed a steered operator follow-up never self-closes on its verdict", async t => {
  const store = await storeFixture(t);
  let h!: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => "Moved all tickets."), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => {
      const live = h.sessions.get("mem:room1")!; (live.steered ??= []).push({ ...msg("Also move the bugs!"), id: "op-late" });
      return { state: "completed" };
    } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await h.submit({ ...msg("Carry over all To Do tickets"), id: "op" });
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  const order = store.tasks().find(task => task.original.startsWith("Carry over"))!;
  assert.equal(order.operatorStatus, "open");
  assert.ok(!order.receipts.some(r => r.kind === "evidence-close"));
  const task = h["tasks"](h.sessions.get("mem:room1")!).find((item: { taskRef?: { id: string } }) => item.taskRef?.id === order.id);
  assert.notEqual(task.state, "completed", "the still-open order keeps a reassessment owner");
});

test("a steered operator follow-up is ledgered: later evidence for the open order and voids other orders' admissions", async t => {
  const store = await storeFixture(t);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(async text => { seen.push(text); if (text.includes("Carry over")) { entered.resolve(); await release.promise; } return "ok"; }),
    executionStore: store, taskLifecycle: { enabled: true }, busyMode: "steer", completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const other = await store.enrollTask("mem:room1", "other", "Plan the sprint", "other", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "other", taskRef: other, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going",
    recoveryAdmission: { id: "other:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: store.operatorMark("mem:room1") },
    anchor: { id: "other", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  const markBefore = store.operatorMark("mem:room1");
  void h.submit({ ...msg("Carry over all To Do tickets"), id: "op" });
  await entered.promise;
  await h.submit({ ...msg("The sprint is already started."), id: "steer-1" });
  const steeredLedgered = store.tasks().some(task => task.sources.some(src => src.text === "The sprint is already started." && src.kind === "operator"));
  assert.ok(steeredLedgered, "steered follow-up is a durable operator source");
  assert.notEqual(store.operatorMark("mem:room1"), markBefore, "watermark changed");
  assert.ok(store.laterOperatorInput("mem:room1", other).some(m => m.text === "The sprint is already started."));
  release.resolve(); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  assert.ok(!seen.some(text => /Resume the explicitly authorized task[\s\S]*Plan the sprint/.test(text)), "other order's stale continuation never ran");
});

test("a steered follow-up whose ledger write fails is not steered but runs as its own next turn", async t => {
  const store = await storeFixture(t);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const seen: string[] = []; let steers = 0;
  const runtime = new FakeRuntime(async text => { seen.push(text); if (text.includes("Carry over")) { entered.resolve(); await release.promise; } return "ok"; });
  const h = new Harness({ runtime, executionStore: store, taskLifecycle: { enabled: true }, busyMode: "steer", completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  void h.submit({ ...msg("Carry over all To Do tickets"), id: "op" });
  await entered.promise;
  const session = h.sessions.get("mem:room1")!.session!; const steer = session.steer.bind(session);
  session.steer = async (text: string) => { steers++; return steer(text); };
  const enroll = store.enrollTask.bind(store); let failOnce = true;
  store.enrollTask = async (...args: Parameters<typeof store.enrollTask>) => { if (failOnce) { failOnce = false; throw Error("disk full"); } return enroll(...args); };
  await h.submit({ ...msg("Also move the bugs."), id: "steer-2" });
  assert.equal(steers, 0, "unledgered operator input never reaches the running turn");
  release.resolve(); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 2000))]);
  assert.ok(seen.some(text => text.includes("Also move the bugs.")), "it ran as its own turn");
  assert.ok(store.tasks().some(task => task.sources.some(src => src.text === "Also move the bugs.")), "and was ledgered then");
});

test("a turn that settles during the steered ledger write gets the follow-up as its own next turn", async t => {
  const store = await storeFixture(t);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const seen: string[] = []; let steers = 0;
  const h = new Harness({ runtime: new FakeRuntime(async text => { seen.push(text); if (text.includes("Carry over")) { entered.resolve(); await release.promise; } return "ok"; }),
    executionStore: store, taskLifecycle: { enabled: true }, busyMode: "steer", completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  void h.submit({ ...msg("Carry over all To Do tickets"), id: "op" });
  await entered.promise;
  const session = h.sessions.get("mem:room1")!.session!; const steer = session.steer.bind(session);
  session.steer = async (text: string) => { steers++; return steer(text); };
  const enroll = store.enrollTask.bind(store);
  store.enrollTask = async (...args: Parameters<typeof store.enrollTask>) => {
    const ref = await enroll(...args);
    if (args[2] === "Also move the bugs.") { release.resolve(); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 300))]); }
    return ref;
  };
  await h.submit({ ...msg("Also move the bugs."), id: "steer-3" });
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 2000))]);
  assert.equal(steers, 0, "not steered into a settled turn");
  assert.ok(seen.some(text => text.includes("Also move the bugs.")), "ran as its own turn, never lost");
});

test("a stop during the steered ledger write discards the follow-up instead of resurrecting it", async t => {
  const store = await storeFixture(t);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(async text => { seen.push(text); if (text.includes("Carry over")) { entered.resolve(); await release.promise; } return "ok"; }),
    executionStore: store, taskLifecycle: { enabled: true }, busyMode: "steer", completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  void h.submit({ ...msg("Carry over all To Do tickets"), id: "op" });
  await entered.promise;
  const enroll = store.enrollTask.bind(store);
  store.enrollTask = async (...args: Parameters<typeof store.enrollTask>) => {
    const ref = await enroll(...args);
    if (args[2] === "Also move the bugs.") { const stopping = h.stopConversation("mem:room1"); release.resolve(); await stopping.catch(() => {}); }
    return ref;
  };
  await h.submit({ ...msg("Also move the bugs."), id: "steer-4" });
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 2000))]);
  assert.ok(!seen.some(text => text.includes("Also move the bugs.")), "a stopped follow-up never runs");
});

test("clock rollback cannot hide a later operator message from the closure fence", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "order-rollback-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 10_000;
  const store = new ExecutionStore(path.join(dir, "executions.json"), { now: () => clock }); await store.load();
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "Moved.", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  const assessedMark = store.operatorMark("mem:room1");
  clock = 5_000; // clock moved backwards
  await store.enrollTask("mem:room1", "late", "Stop, do not close", "late", "operator");
  assert.equal(store.laterOperatorInput("mem:room1", ref).length, 1, "insertion order still sees it");
  assert.equal(await h["closeOrderByEvidence"](s, task, "e-rb", "Moved", true, 1, undefined, assessedMark), "refused", "identity fence catches it");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open");
});

test("an operator message still in the inbox handoff (awaiting its ledger write) fences closure", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "Moved.", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  const pending = { ...msg("Also the bugs"), id: "handoff-1" };
  h["inbox"].handoff.add(pending);
  assert.equal(await h["closeOrderByEvidence"](s, task, "e-h", "Moved", true, 1, undefined, store.operatorMark("mem:room1")), "refused");
  h["inbox"].handoff.delete(pending);
  assert.equal(await h["closeOrderByEvidence"](s, task, "e-h2", "Moved", true, 1, undefined, store.operatorMark("mem:room1")), "closed");
});

test("clock rollback before the assessment snapshot still exposes the newer order's message as later input", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "order-rollback2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 10_000;
  const store = new ExecutionStore(path.join(dir, "executions.json"), { now: () => clock }); await store.load();
  const old = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  clock = 5_000; // rolled back before the newer message
  await store.enrollTask("mem:room1", "new", "The sprint is already started", "new", "operator");
  assert.deepEqual(store.laterOperatorInput("mem:room1", old).map(m => m.text), ["The sprint is already started"]);
});

test("a clarification of an older sibling under clock rollback is still later input (ingress sequence)", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "order-rollback3-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 10_000;
  const store = new ExecutionStore(path.join(dir, "executions.json"), { now: () => clock }); await store.load();
  const sibling = await store.enrollTask("mem:room1", "sib", "Older sibling", "sib", "operator");
  clock = 20_000;
  const current = await store.enrollTask("mem:room1", "cur", "Current order", "cur", "operator");
  clock = 15_000; // rolled back: the clarification has an earlier timestamp than the current order
  await store.decideTask(sibling, 1, "clar-1", "clarify", "Everything is already done, stop");
  assert.deepEqual(store.laterOperatorInput("mem:room1", current).map(m => m.text), ["Everything is already done, stop"]);
  // The counter survives a reload.
  const reloaded = new ExecutionStore(path.join(dir, "executions.json"), { now: () => clock }); await reloaded.load();
  assert.deepEqual(reloaded.laterOperatorInput("mem:room1", current).map(m => m.text), ["Everything is already done, stop"]);
});

test("a pre-upgrade order without sequence still sees new sibling input under clock rollback", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "order-legacy-seq-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = 20_000;
  const store = new ExecutionStore(path.join(dir, "executions.json"), { now: () => clock }); await store.load();
  const legacy = await store.enrollTask("mem:room1", "legacy", "Pre-upgrade order", "legacy", "operator");
  const book = store["data"].taskBook!; book.tasks[0].sources.forEach((src: { seq?: number }) => { delete src.seq; }); delete book.sourceSeq;
  clock = 5_000;
  await store.enrollTask("mem:room1", "new", "Already done, stop", "new", "operator");
  assert.deepEqual(store.laterOperatorInput("mem:room1", legacy).map(m => m.text), ["Already done, stop"]);
});

test("a checkpoint taken during the steered ledger write (turn settling) still persists the follow-up", async t => {
  const store = await storeFixture(t);
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const h = new Harness({ runtime: new FakeRuntime(async text => { if (text.includes("Carry over")) { entered.resolve(); await release.promise; } return "ok"; }),
    executionStore: store, taskLifecycle: { enabled: true }, busyMode: "steer", completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  void h.submit({ ...msg("Carry over all To Do tickets"), id: "op" });
  await entered.promise;
  const sessions = () => [...h.sessions.values()];
  let snapshotDuringWrite: string[] = [];
  const enroll = store.enrollTask.bind(store);
  store.enrollTask = async (...args: Parameters<typeof store.enrollTask>) => {
    const ref = await enroll(...args);
    if (args[2] === "Also move the bugs.") {
      release.resolve(); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 300))]);
      // What a crash right now would recover from: the durable inbox snapshot.
      snapshotDuringWrite = h["inbox"].snapshot(sessions()).map((input: { text: string }) => input.text);
    }
    return ref;
  };
  await h.submit({ ...msg("Also move the bugs."), id: "steer-5" });
  assert.ok(snapshotDuringWrite.includes("Also move the bugs."), "the accepted follow-up is in the durable inbox during the write");
});

test("after a crash between evidence close and checkpoint, closures are reconciled before any continuation runs", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const other = await store.enrollTask("mem:room1", "other", "Plan the sprint", "other", "operator");
  const closed = await store.enrollTask("mem:room1", "closed", "Carry over tickets", "closed", "operator");
  assert.equal(await store.closeTaskByEvidence(closed, 1, "evidence-close:n:a", "All moved"), true);
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [
    { id: "other", taskRef: other, original: "Plan the sprint", state: "active", depth: 1, recoveryEnrollment: "current", next: "keep going",
      recoveryAdmission: { id: "other:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: store.operatorMark("mem:room1") },
      anchor: { id: "other", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } },
    { id: "closed", taskRef: closed, original: "Carry over tickets", state: "active", depth: 1, recoveryEnrollment: "current",
      anchor: { id: "closed", task: "Carry over tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  assert.equal(h["queueRunnableTask"](s), false, "no scheduling before reconciliation");
  assert.equal(h["tasks"](s).find((item: { id: string }) => item.id === "closed").state, "completed");
  assert.equal(s.outbox.filter(entry => entry.id === `evidence-close:${closed.id}:${closed.generation}`).length, 1, "owed notice restored first");
});

test("startup recovery reconciles evidence closures before releasing any admitted continuation", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "ok"), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const other = await store.enrollTask("mem:room1", "other", "Plan the sprint", "other", "operator");
  const closed = await store.enrollTask("mem:room1", "closed", "Carry over tickets", "closed", "operator");
  assert.equal(await store.closeTaskByEvidence(closed, 1, "evidence-close:n:b", "All moved"), true);
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [
    { id: "other", taskRef: other, original: "Plan the sprint", state: "active", depth: 1, recoveryEnrollment: "current", next: "keep going",
      recoveryAdmission: { id: "other:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: store.operatorMark("mem:room1") },
      anchor: { id: "other", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } },
    { id: "closed", taskRef: closed, original: "Carry over tickets", state: "active", depth: 1, recoveryEnrollment: "current",
      anchor: { id: "closed", task: "Carry over tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  h["paused"] = true; // observe the reconciled state without running turns
  await h.recoverTasks();
  const s = h.sessions.get("mem:room1")!;
  assert.equal(h["tasks"](s).find((item: { id: string }) => item.id === "closed").state, "completed");
  assert.equal(s.outbox.filter(entry => entry.id === `evidence-close:${closed.id}:${closed.generation}`).length, 1);
});

test("the pump reconciles evidence closures before running a restored queued continuation", async t => {
  const store = await storeFixture(t);
  const ran: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (ran.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const closed = await store.enrollTask("mem:room1", "closed", "Carry over tickets", "closed", "operator");
  assert.equal(await store.closeTaskByEvidence(closed, 1, "evidence-close:n:c", "All moved"), true);
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [
    { id: "closed", taskRef: closed, original: "Carry over tickets", state: "active", depth: 1, recoveryEnrollment: "current",
      anchor: { id: "closed", task: "Carry over tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  // A continuation of the (already ledger-closed) order was checkpointed in the queue before the crash.
  s.queue.push({ sessionKey: s.key, source: "cron", text: "CONTINUE stale carry-over", replyTo: ROOM, taskId: "closed", depth: 2, id: "closed:2" } as never);
  await h["pump"](s);
  assert.equal(ran.some(text => text.includes("CONTINUE stale carry-over")), false, "the stale continuation never ran");
  assert.equal(h["tasks"](s).find((item: { id: string }) => item.id === "closed").state, "completed");
  assert.equal(channel.sent.filter(m => m.text.includes(`/orders reopen ${closed.id}`)).length, 1, "exactly one notice");
});

test("ingress order is fixed at acceptance: a delayed (inverted) enrollment keeps its earlier sequence", async t => {
  const store = await storeFixture(t);
  const olderSeq = await store.reserveSourceSeq(); // older message accepted, enrollment delayed (handoff/restart)
  const newer = await store.enrollTask("mem:room1", "newer", "Stop, the sprint already started", "newer", "operator", await store.reserveSourceSeq());
  const older = await store.enrollTask("mem:room1", "older", "Plan the sprint", "older", "operator", olderSeq);
  assert.deepEqual(store.laterOperatorInput("mem:room1", older).map(m => m.text), ["Stop, the sprint already started"], "the newer instruction is later than the older order");
  assert.deepEqual(store.laterOperatorInput("mem:room1", newer), [], "the older message is not later than the newer order");
});

test("accept() reserves the operator sequence before the input is processed", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "ok"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const input = { ...msg("Plan the sprint"), id: "acc-1" };
  await h.accept(input);
  assert.ok(Number.isSafeInteger((input as { operatorSeq?: number }).operatorSeq));
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 2000))]); await store.quiesce();
});

test("ingress reservation is synchronous at acceptance, survives restart, and is never reissued", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "ok"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const input = { ...msg("Plan the sprint"), id: "sync-1" };
  const pending = h.accept(input);
  // Before the first await of accept(): claimed, fenced and sequenced together.
  assert.ok(Number.isSafeInteger((input as { operatorSeq?: number }).operatorSeq));
  assert.equal(h["inbox"].accepting.has(input), true);
  await pending; await Promise.race([h.drained(), new Promise(r => setTimeout(r, 2000))]); await store.quiesce();
  // A restored (persisted) reservation is never handed out again.
  h.restorePending([{ ...msg("Restored"), id: "r-1", operatorSeq: 50 } as never]);
  assert.ok(store.reserveSourceSeq() > 50);
});

test("a restored, not-yet-enrolled API input keeps its operator classification and ingress order", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const older = await store.enrollTask("mem:room1", "older", "Plan the sprint", "older", "operator", store.reserveSourceSeq());
  const seq = store.reserveSourceSeq(); // accepted before the crash, persisted with the input
  h.restorePending([{ ...msg("The sprint is already started."), source: "api", id: "api-r1", operatorSeq: seq, replyTo: { channel: "api", target: "run-r1" } } as never]);
  await h.start(); h.releaseRestored();
  const settle = () => Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  await settle();
  assert.ok(seen.some(text => text.includes("already started")), "the restored API turn ran");
  const restored = store.tasks().find(task => task.original === "The sprint is already started.")!;
  assert.equal(restored.scheduled, false); assert.equal(restored.operatorStatus, "open");
  assert.deepEqual(store.laterOperatorInput("mem:room1", older).map(m => m.text), ["The sprint is already started."]);
});

test("startup recovery never resumes an admission older than ledgered operator input", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  const mark = store.operatorMark("mem:room1");
  await store.enrollTask("mem:room1", "newer", "Stop, the sprint already started", "newer", "operator"); // ledgered before the crash
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [
    { id: "old", taskRef: ref, original: "Plan the sprint", state: "active", depth: 1, recoveryEnrollment: "current", next: "keep going",
      recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: mark },
      anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.start(); await h.recoverTasks(true); h.releaseRestored();
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  assert.ok(!seen.some(text => /Resume the authorized task after restart/.test(text)), "no stale startup continuation ran");
  const task = h["tasks"](h.sessions.get("mem:room1")!).find((item: { id: string }) => item.id === "old");
  assert.equal(task.recoveryAdmission, undefined, "withdrawn for reassessment");
});

test("a timer wait recheck never runs as work after newer operator input; it is reassessed instead", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Watch the deploy", "old", "operator");
  const mark = store.operatorMark("mem:room1");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Watch the deploy", state: "waiting", depth: 1,
    recoveryEnrollment: "current", next: "check rollout status",
    wait: { reason: "rollout running", nextAt: 1, deadline: Date.now() + 3600000, operatorMark: mark },
    anchor: { id: "old", task: "Watch the deploy", receivedAt: 1, replyTo: ROOM } }] }]);
  await store.enrollTask("mem:room1", "newer", "Deploy was rolled back, stop watching", "newer", "operator");
  await h.tick();
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  assert.ok(!seen.some(text => /Recheck a persisted wait/.test(text)), "no working wait recheck ran past the newer operator input");
});

test("after the single stalled question, the next operator message re-arms exactly one reassessment", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Reconcile TEST board", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Reconcile TEST board", state: "active", depth: 1,
    recoveryEnrollment: "current", anchor: { id: "order", task: "Reconcile TEST board", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  for (let i = 0; i < 3; i++) h["retainForReassessment"](task, s);
  assert.equal(task.state, "blocked");
  h["recheckOrdersAfterOperatorInput"](s, "other");
  assert.equal(task.state, "active", "re-armed for one read-only reassessment");
  assert.equal(task.recoveryAdmission, undefined, "no work admitted");
  h["recheckOrdersAfterOperatorInput"](s, "other");
  assert.equal(s.outbox.filter(entry => entry.id === `evidence-stalled:${ref.id}:${ref.generation}`).length, 1, "no reminder");
});

test("operator input ledgered during turn preparation still stops a stale continuation before the prompt", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  let injected = false;
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }),
    beforeTurn: async (input: { source: string }) => {
      if (input.source === "cron" && !injected) { injected = true; await store.enrollTask("mem:room1", "newer", "Stop, the sprint already started", "newer", "operator"); }
    } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going", lastReply: "Previous result: 3 of 5 sprint items planned.",
    recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: store.operatorMark("mem:room1") },
    anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  assert.equal(h["queueRunnableTask"](s), true);
  await h["pump"](s);
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  assert.equal(injected, true, "operator input arrived during preparation");
  assert.ok(!seen.some(text => /keep going/.test(text)), "the stale continuation never reached the model");
  const task = h["tasks"](s).find((item: { id: string }) => item.id === "old");
  assert.equal(task.recoveryAdmission, undefined); assert.notEqual(task.state, "completed");
  // Withdrawn, not a cancelled/failed turn: retained evidence for the reassessment survives.
  assert.equal(task.lastReply, "Previous result: 3 of 5 sprint items planned.");
  assert.equal(task.next, "keep going");
  assert.notEqual(store.coreTask(ref.id)!.technical.state, "failed", "no failed outcome recorded on the order");
});

test("the single stalled question is never repeated after delivery and a later re-arm", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Reconcile TEST board", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Reconcile TEST board", state: "active", depth: 1,
    recoveryEnrollment: "current", anchor: { id: "order", task: "Reconcile TEST board", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  const qid = `evidence-stalled:${ref.id}:${ref.generation}`;
  for (let i = 0; i < 3; i++) h["retainForReassessment"](task, s);
  assert.equal(s.outbox.filter(entry => entry.id === qid).length, 1);
  s.outbox = s.outbox.filter(entry => entry.id !== qid); // delivered
  h["recheckOrdersAfterOperatorInput"](s, "other");
  for (let i = 0; i < 3; i++) h["retainForReassessment"](task, s);
  assert.equal(s.outbox.filter(entry => entry.id === qid).length, 0, "never asked twice for the same order generation");
  assert.equal(task.state, "blocked");
});

test("operator input ledgered during the last preparation await (attachments/instructions) still stops the stale continuation", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  let injected = false;
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }),
    // capabilityContext is evaluated synchronously while building the prompt options, i.e. after
    // the last earlier checkExpiry and after the attachment await: ledger the input right there.
    capabilityContext: (input: { source: string }) => {
      if (input.source === "cron" && !injected) { injected = true; ledgerNow(); }
      return undefined;
    } } as never);
  let ledgerNow = () => {};
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  // A ledger write that completed during the preparation awaits: the watermark moves on.
  const realMark = store.operatorMark.bind(store); let switched = false;
  store.operatorMark = (key: string) => switched ? realMark(key) + ":newer" : realMark(key);
  ledgerNow = () => { switched = true; };
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going",
    recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: realMark("mem:room1") },
    anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  assert.equal(h["queueRunnableTask"](s), true);
  await h["pump"](s);
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  assert.equal(injected, true);
  assert.ok(!seen.some(text => /keep going/.test(text)), "never reached the model");
});

test("a withdrawn turn whose settlement fails is retained as withdrawn and never executed on retry", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  let injected = false;
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "waiting", reason: "x" }),
    beforeTurn: async (input: { source: string }) => {
      if (input.source === "cron" && !injected) { injected = true; await store.enrollTask("mem:room1", "newer", "Stop, the sprint already started", "newer", "operator"); }
    } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "old", "Plan the sprint", "old", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "old", taskRef: ref, original: "Plan the sprint", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "keep going", lastReply: "3 of 5 planned.",
    recoveryAdmission: { id: "old:2", depth: 2, next: "keep going", original: "Plan the sprint", operatorMark: store.operatorMark("mem:room1") },
    anchor: { id: "old", task: "Plan the sprint", receivedAt: 1, replyTo: ROOM } }] }]);
  const settle = store.settleTurn.bind(store); let failures = 1;
  store.settleTurn = async (...args: Parameters<typeof store.settleTurn>) => { if (failures-- > 0) throw Error("disk full"); return settle(...args); };
  const s = h.sessions.get("mem:room1")!;
  assert.equal(h["queueRunnableTask"](s), true);
  await h["pump"](s);
  assert.equal(s.queue.length, 1); assert.equal(s.queue[0].withdrawn, true, "retained with its withdrawal marker");
  await h["pump"](s); // retry: settles empty, never prompts
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  assert.ok(!seen.some(text => /keep going/.test(text)), "never executed");
  assert.equal(s.queue.some(input => input.withdrawn), false, "dropped after the empty settlement");
  const task = h["tasks"](s).find((item: { id: string }) => item.id === "old");
  assert.equal(task.lastReply, "3 of 5 planned."); assert.notEqual(store.coreTask(ref.id)!.technical.state, "failed");
});

test("operator ingress is serialized with an in-flight evidence closure commit", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "ok"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "Moved.", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  // The guard has passed; the close is committing (storage awaits) when the operator writes.
  const gate = Promise.withResolvers<void>(), committing = Promise.withResolvers<void>();
  const close = store.closeTaskByEvidence.bind(store);
  store.closeTaskByEvidence = async (...args: Parameters<typeof store.closeTaskByEvidence>) => { committing.resolve(); await gate.promise; return close(...args); };
  const closing = h["closeOrderByEvidence"](s, task, "e-ser", "Moved", true, 1, undefined, store.operatorMark("mem:room1"));
  await committing.promise;
  const input = { ...msg("Also move the bugs"), id: "late-ser" };
  const accepted = h.accept(input);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(h["inbox"].accepting.has(input), false, "acceptance waits until the closure has committed");
  assert.equal(s.queue.includes(input), false);
  gate.resolve();
  // The in-mutation guard sees the registered ingress: the closure never commits past it.
  assert.equal(await closing, "refused");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open");
  await accepted;
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]); await store.quiesce();
  assert.ok(store.tasks().some(item => item.original === "Also move the bugs"), "the message is accepted after the closure attempt");
});

test("an operator message still inside accept() (e.g. loading attachments) fences a closure that starts meanwhile", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "ok"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "active", depth: 1,
    recoveryEnrollment: "current", lastReply: "Moved.", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  // Hold the message inside accept() before it reaches the inbox (as an attachment load would).
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const original = h["acceptInput"].bind(h);
  h["acceptInput"] = async (input: unknown) => { entered.resolve(); await gate.promise; return original(input); };
  const accepted = h.accept({ ...msg("Also move the bugs"), id: "att-1" });
  await entered.promise;
  assert.equal(await h["closeOrderByEvidence"](s, task, "e-att", "Moved", true, 1, undefined, store.operatorMark("mem:room1")), "refused");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open");
  gate.resolve(); await accepted;
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]); await store.quiesce();
});

test("a message delayed by attachment loading keeps its arrival order against a later message", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "ok"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const gate = Promise.withResolvers<void>();
  const original = h["acceptInput"].bind(h);
  const first = { ...msg("Plan the sprint"), id: "ord-1" }, second = { ...msg("Stop, the sprint already started"), id: "ord-2" };
  h["acceptInput"] = async (input: { id?: string }) => { if (input.id === "ord-1") await gate.promise; return original(input); };
  const a = h.accept(first);
  const b = h.accept(second);
  await b; gate.resolve(); await a;
  assert.ok((first as { operatorSeq?: number }).operatorSeq! < (second as { operatorSeq?: number }).operatorSeq!,
    "the earlier arrival keeps the lower sequence although it finished accepting later");
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 2000))]); await store.quiesce();
});

test("a delayed clarification keeps its ingress position against a later message enrolled first", async t => {
  const store = await storeFixture(t);
  const order = await store.enrollTask("mem:room1", "order", "Plan the sprint", "order", "operator", store.reserveSourceSeq());
  const clarifySeq = store.reserveSourceSeq(); // clarification accepted first, its mutation delayed
  await store.enrollTask("mem:room1", "later", "Stop, the sprint already started", "later", "operator", store.reserveSourceSeq());
  const record = store.coreTask(order.id)!;
  const ref = await store.decideTask(order, record.revision, "clarify-1", "clarify", "Only the backend items", undefined, clarifySeq);
  assert.deepEqual(store.laterOperatorInput("mem:room1", ref).map(m => m.text), ["Stop, the sprint already started"],
    "the later stop stays evidence for the clarified order");
  // The tool path forwards the originating input's reservation.
  const pure: TaskBook = { tasks: [], bindings: [] };
  const r = enrollTask(pure, { sessionKey: "room", taskId: "o" }, "Plan", "o", "operator", 1, 1);
  enrollTask(pure, { sessionKey: "room", taskId: "l" }, "Later", "l", "operator", 2, 3);
  operatorTransition(pure, r, pure.tasks[0].revision, "c", "clarify", "Clarified", 4, 2);
  assert.deepEqual(laterOperatorInput(pure, "room", r).map(m => m.text), ["Later"]);
});

test("a steered follow-up on a completed verdict with open plan todos keeps a reassessment owner", async t => {
  const store = await storeFixture(t);
  let h!: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => "Moved all tickets."), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => {
      const live = h.sessions.get("mem:room1")!; (live.steered ??= []).push({ ...msg("Also move the bugs!"), id: "op-late2" });
      return { state: "completed" };
    } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  // The order carries an unfinished todo: a completed verdict leaves the task "waiting".
  const coreTask = store.coreTask.bind(store);
  store.coreTask = (id: string) => { const task = coreTask(id); return task && { ...task, plan: [{ id: "t", title: "TEST-266", kind: "work", status: "running", sourceId: "op2" }] } as never; };
  await h.submit({ ...msg("Carry over all To Do tickets"), id: "op2" });
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1500))]);
  const order = store.tasks().find(task => task.original.startsWith("Carry over"))!;
  assert.equal(order.operatorStatus, "open");
  const task = h["tasks"](h.sessions.get("mem:room1")!).find((item: { taskRef?: { id: string } }) => item.taskRef?.id === order.id);
  assert.ok(task.recoveryRetry || task.recoveryAdmission || task.wait || task.state === "active",
    `the open order has a durable reassessment owner (state ${task.state})`);
});

test("a crash between turn settlement and the closure attempt is reconciled at startup by one read-only reassessment", async t => {
  const store = await storeFixture(t);
  const seen: string[] = []; let checks = 0;
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "unused")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => (checks++, { state: "completed" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  // The settled turn committed a completed outcome; the session checkpoint (closure attempt) was lost.
  await store.beginTurn("turn-1", "mem:room1");
  await store.settleTurn("turn-1", "mem:room1", { consumed: [], outbox: [], taskOutcome: { ref, expectedRevision: 1, eventId: "turn-1", technical: { state: "completed", evidence: "Moved." } } });
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "completed", depth: 1,
    recoveryEnrollment: "current", lastReply: "Moved.", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.recoverTasks();
  const s = h.sessions.get("mem:room1")!; const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  assert.ok(task.recoveryRetry, "open order with a completed outcome gets a reassessment owner");
  task.recoveryRetry.nextAt = 0;
  for (let i = 0; i < 5 && store.coreTask(ref.id)!.operatorStatus === "open"; i++) {
    await h["pump"](s); await h.tick(); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 300))]); await store.quiesce();
  }
  assert.ok(checks >= 1, "read-only reassessment ran");
  assert.equal(seen.length, 0, "no work was admitted");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "done", "the order closed itself on the reassessed evidence");
  // Never re-armed for the same generation.
  await h.recoverTasks();
  assert.equal(h["tasks"](s).find((item: { id: string }) => item.id === "order").recoveryRetry, undefined);
});

test("a read-only closure reassessment never admits work on a continue verdict", async t => {
  const store = await storeFixture(t);
  const seen: string[] = []; let checks = 0;
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "unused")), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => (checks++, { state: "continue", next: "start over and move everything again" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  await store.beginTurn("turn-1", "mem:room1");
  await store.settleTurn("turn-1", "mem:room1", { consumed: [], outbox: [], taskOutcome: { ref, expectedRevision: 1, eventId: "turn-1", technical: { state: "completed", evidence: "Moved." } } });
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "completed", depth: 1,
    recoveryEnrollment: "current", lastReply: "Moved.", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.recoverTasks();
  const s = h.sessions.get("mem:room1")!; const task = () => h["tasks"](s).find((item: { id: string }) => item.id === "order");
  for (let i = 0; i < 4; i++) {
    if (task().recoveryRetry) task().recoveryRetry.nextAt = 0;
    await h["pump"](s); await h.tick(); await Promise.race([h.drained(), new Promise(r => setTimeout(r, 300))]); await store.quiesce();
  }
  assert.ok(checks >= 1, "reassessed");
  assert.equal(seen.length, 0, "no productive continuation ran");
  assert.equal(task().recoveryAdmission, undefined);
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open");
  assert.ok(task().recoveryRetry || task().state === "blocked", "bounded owner or the single question");
});

test("a closure-only owner never runs work from any admission path (scheduling and execution gates)", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "ok")), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  // E.g. the dependency-supervision path proposed an independent admission.
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "active", depth: 1,
    recoveryEnrollment: "current", next: "move everything again", lastReply: "Moved.", closureOnly: true,
    recoveryAdmission: { id: "order:2", depth: 2, next: "move everything again", original: "Carry over", operatorMark: store.operatorMark("mem:room1") },
    anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  const task = () => h["tasks"](s).find((item: { id: string }) => item.id === "order");
  assert.equal(h["queueRunnableTask"](s), false, "scheduling gate");
  assert.equal(task().recoveryAdmission, undefined);
  // A restored queued continuation (bypassing scheduling) hits the execution gate.
  task().recoveryAdmission = { id: "order:2", depth: 2, next: "move everything again", original: "Carry over", operatorMark: store.operatorMark("mem:room1") };
  s.queue.push({ sessionKey: "mem:room1", source: "cron", text: "move everything again", id: "order:2", taskId: "order", taskRef: ref, continuationDepth: 2, replyTo: ROOM } as never);
  await h["pump"](s);
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1000))]); await store.quiesce();
  assert.ok(!seen.some(text => /move everything again/.test(text)), "execution gate");
  assert.equal(store.coreTask(ref.id)!.technical.state === "failed", false);
});

test("an operator reply re-arms a stalled closure-only order read-only (closure-only kept)", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "ok"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "blocked", depth: 1,
    recoveryEnrollment: "current", lastReply: "Moved.", closureOnly: true, evidenceStalled: true, recoveryAttentionId: "x",
    anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  h["recheckOrdersAfterOperatorInput"](s);
  const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  assert.equal(task.state, "active"); assert.equal(task.closureOnly, true); assert.equal(task.recoveryAdmission, undefined);
});

test("a replayed settlement (crash before the session checkpoint) keeps the reply and a closure-only owner", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "unused")), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  await store.beginTurn("turn-1", "mem:room1");
  await store.settleTurn("turn-1", "mem:room1", { consumed: [], outbox: [], continuation: { taskId: "order", state: "completed" } as never,
    taskOutcome: { ref, expectedRevision: 1, eventId: "turn-1", technical: { state: "completed", evidence: "Moved all tickets." } } });
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "active", depth: 0,
    recoveryEnrollment: "current", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  s.queue.push({ ...msg("Carry over"), id: "order", taskId: "order", taskRef: ref, taskRevision: 1, executionTurnId: "turn-1", started: true } as never);
  await h["pump"](s);
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1000))]); await store.quiesce();
  assert.equal(seen.length, 0, "replayed, not re-run");
  const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open");
  assert.equal(task.lastReply, "Moved all tickets.", "settled result restored as completion evidence");
  assert.ok(task.recoveryRetry && task.closureOnly, `closure-only reassessment owner (state ${task.state})`);
});

test("a replayed settlement with open todos (task waiting, no wait) keeps an ordinary reassessment owner", async t => {
  const store = await storeFixture(t);
  const seen: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(text => (seen.push(text), "unused")), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over", "order", "operator");
  await store.beginTurn("turn-1", "mem:room1");
  await store.settleTurn("turn-1", "mem:room1", { consumed: [], outbox: [], continuation: { taskId: "order", state: "completed" } as never,
    taskOutcome: { ref, expectedRevision: 1, eventId: "turn-1", technical: { state: "completed", evidence: "Moved 3 of 5." },
      plan: [{ id: "t", title: "TEST-266", kind: "work", status: "running", sourceId: "order" }] } });
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over", state: "active", depth: 0,
    recoveryEnrollment: "current", anchor: { id: "order", task: "Carry over", receivedAt: 1, replyTo: ROOM } }] }]);
  const s = h.sessions.get("mem:room1")!;
  s.queue.push({ ...msg("Carry over"), id: "order", taskId: "order", taskRef: ref, taskRevision: 1, executionTurnId: "turn-1", started: true } as never);
  await h["pump"](s);
  await Promise.race([h.drained(), new Promise(r => setTimeout(r, 1000))]); await store.quiesce();
  assert.equal(seen.length, 0);
  const task = h["tasks"](s).find((item: { id: string }) => item.id === "order");
  assert.equal(store.coreTask(ref.id)!.operatorStatus, "open");
  assert.ok(task.recoveryRetry, `reassessment owner (state ${task.state})`);
  assert.notEqual(task.closureOnly, true, "open todos: remaining work may be admitted by an independent verdict");
});

test("a checkpoint showing the task completed before the close committed still restores the one owed notice", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const ref = await store.enrollTask("mem:room1", "order", "Carry over all To Do tickets", "order", "operator");
  assert.equal(await store.closeTaskByEvidence(ref, 1, "evidence-close:n:assessment:order:1:1", "All moved"), true);
  // The persisted checkpoint already had state "completed" (set before the commit was awaited), but no notice.
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [{ id: "order", taskRef: ref, original: "Carry over all To Do tickets", state: "completed", depth: 1,
    recoveryEnrollment: "current", anchor: { id: "order", task: "Carry over all To Do tickets", receivedAt: 1, replyTo: ROOM } }] }]);
  await h.recoverTasks(); await h["pump"](h.sessions.get("mem:room1")!);
  await h.tick(); await h.drained(); await h.tick(); await h.drained();
  await h.recoverTasks(); await h.tick(); await h.drained();
  assert.equal(channel.sent.filter(s => s.text.includes("/orders reopen")).length, 1, "exactly one notice, never repeated");
});

test("scheduling reconciles every durable evidence closure of the session before any admission", async t => {
  const store = await storeFixture(t);
  const h = new Harness({ runtime: new FakeRuntime(() => "unused"), executionStore: store, taskLifecycle: { enabled: true } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const a = await store.enrollTask("mem:room1", "a", "Order A", "a", "operator");
  const b = await store.enrollTask("mem:room1", "b", "Order B", "b", "operator");
  assert.equal(await store.closeTaskByEvidence(a, 1, "evidence-close:n:a", "A done"), true);
  assert.equal(await store.closeTaskByEvidence(b, 1, "evidence-close:n:b", "B done"), true);
  const task = (id: string, ref: typeof a) => ({ id, taskRef: ref, original: `Order ${id.toUpperCase()}`, state: "active", depth: 1, recoveryEnrollment: "current",
    anchor: { id, task: `Order ${id.toUpperCase()}`, receivedAt: 1, replyTo: ROOM } });
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, tasks: [task("a", a), task("b", b)] as never }]);
  const s = h.sessions.get("mem:room1")!;
  assert.equal(h["queueRunnableTask"](s), false);
  for (const id of ["a", "b"]) assert.equal(h["tasks"](s).find((item: { id: string }) => item.id === id).state, "completed", `${id} reconciled in the same pass`);
});
