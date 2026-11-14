import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { taskLifecyclePlugin } from "../src/task-lifecycle-plugin.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";
import { enrollTask, operatorTransition, commitTaskOutcome, expireInactiveTasks, taskOpen, validateTaskBook, renderTask, type TaskBook, type TaskTodo } from "../src/task-lifecycle.js";

function fixture() {
  const book: TaskBook = { tasks: [], bindings: [] };
  const ref = enrollTask(book, { sessionKey: "original", taskId: "operator" }, "Fix the owned deliverable", "operator", "operator", 1000);
  return { book, ref, task: book.tasks[0] };
}
const plan = (sourceId = "operator"): TaskTodo[] => ["memory-research", "skill-research", "source-research", "internet-research", "work", "verification", "skill-check", "delivery"].map((kind, i) => ({ id: `todo-${i}`, title: kind, kind: kind as TaskTodo["kind"], status: "open", sourceId }));
async function storeFixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), "task-book-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json"); const store = new ExecutionStore(file, { now: () => 1000 }); await store.load();
  return { home, file, store };
}

test("operator completion is independent of failed validation, idempotent, and permanent for its generation", () => {
  const { book, ref, task } = fixture();
  commitTaskOutcome(book, { ref, expectedRevision: 1, eventId: "turn", technical: { state: "blocked", evidence: "Approval still missing" } }, 1100);
  operatorTransition(book, ref, 2, "human-done", "close", "Leave it; this topic is done", 1200);
  operatorTransition(book, ref, 2, "human-done", "close", "Leave it; this topic is done", 1200);
  assert.equal(task.operatorStatus, "done"); assert.equal(task.technical.state, "blocked"); assert.equal(task.revision, 3);
  commitTaskOutcome(book, { ref, expectedRevision: 3, eventId: "late-worker", technical: { state: "open" }, plan: plan() }, 1300);
  assert.equal(task.revision, 3); assert.equal(task.plan, undefined); assert.equal(taskOpen(book, ref), false);
  assert.match(renderTask(task), /Auftrag erledigt/); assert.match(renderTask(task), /unabhängig.*blocked/);
  validateTaskBook(book);
});

test("explicit reopening mints a new generation, retaining technical evidence and invalidating old permits", () => {
  const { book, ref, task } = fixture();
  operatorTransition(book, ref, 1, "close", "close", "Done", 1100);
  const next = operatorTransition(book, ref, 2, "reopen", "reopen", "Please reopen this exact order", 1200);
  assert.equal(next.generation, 2); assert.equal(taskOpen(book, ref), false); assert.equal(taskOpen(book, next), true);
  assert.equal(book.bindings[0].ref.generation, 1, "old session permits are not silently upgraded");
  assert.throws(() => operatorTransition(book, ref, 2, "other", "close", "stale", 1300), /stale/);
  assert.throws(() => operatorTransition(book, next, 1, "other", "close", "outdated", 1300), /revision/);
  validateTaskBook(book);
});

test("clarification retains the original request and supplies an authentic source for a new todo", () => {
  const { book, ref, task } = fixture();
  operatorTransition(book, ref, 1, "clarification", "clarify", "Also update the regression skill", 1100);
  assert.equal(task.original, "Fix the owned deliverable"); assert.equal(task.sources[1].text, "Also update the regression skill");
  commitTaskOutcome(book, { ref, expectedRevision: 2, eventId: "turn", technical: { state: "open" },
    plan: [...plan(), { id: "skill-change", kind: "skill-change", title: "Update regression skill", status: "open", sourceId: "clarification" }] }, 1200);
  validateTaskBook(book); assert.equal(task.plan!.length, 9);
});

test("plans require research and a final skill-check; omitted research needs a reason, and completed todos cannot be reopened by another outcome", () => {
  const { book, ref, task } = fixture();
  assert.throws(() => commitTaskOutcome(book, { ref, expectedRevision: 1, eventId: "bad", technical: { state: "open" }, plan: plan().filter(t => t.kind !== "skill-check") }, 1001), /skill-check/);
  const initial = plan(); initial[3] = { ...initial[3], status: "omitted", outcome: "No external facts needed; private source-only fix" };
  initial[0] = { ...initial[0], status: "done", outcome: "Existing decisions found; reference memory/decision-1" };
  commitTaskOutcome(book, { ref, expectedRevision: 1, eventId: "first", technical: { state: "open" }, plan: initial }, 1100);
  const replay = structuredClone(initial); replay[0].status = "open";
  assert.throws(() => commitTaskOutcome(book, { ref, expectedRevision: 2, eventId: "recheck", technical: { state: "open" }, plan: replay }, 1200), /settled todos/);
  const noReason = plan(); noReason[0].status = "done";
  assert.throws(() => commitTaskOutcome(book, { ref, expectedRevision: 2, eventId: "no-evidence", technical: { state: "open" }, plan: noReason }, 1200), /outcome/);
  assert.equal(task.plan![0].status, "done");
});

test("outcomes do not change the operator activity clock; explicit inactivity policy closes only non-scheduled orders", () => {
  const { book, ref, task } = fixture();
  enrollTask(book, { sessionKey: "cron:daily", taskId: "occurrence" }, "Explicit daily audit", "cron-occurrence", "schedule", 1000);
  commitTaskOutcome(book, { ref, expectedRevision: 1, eventId: "result", technical: { state: "running" } }, 60000);
  assert.equal(task.lastOperatorAt, 1000);
  assert.throws(() => expireInactiveTasks(book, 61000, 0), /Explicit/);
  assert.deepEqual(expireInactiveTasks(book, 61000, 60000), [ref.id]);
  assert.equal(book.tasks[1].operatorStatus, "open"); assert.equal(task.technical.state, "running");
});

test("unknown historical tasks are quarantined without rewriting their technical evidence", () => {
  const book: TaskBook = { tasks: [], bindings: [] };
  const ref = enrollTask(book, { sessionKey: "old", taskId: "old" }, "Potentially completed days ago", "old", "legacy", 1000);
  assert.equal(taskOpen(book, ref), false); assert.equal(book.tasks[0].operatorStatus, "unresolved");
  assert.equal(enrollTask(book, { sessionKey: "old", taskId: "old" }, "Potentially completed days ago", "old", "operator", 1001).id, ref.id, "new ingress classification cannot reenroll an existing binding");
});

test("task book survives reload without dispatcher; close from another conversation blocks stale child claims", async t => {
  const { store, file } = await storeFixture(t);
  const ref = await store.enrollTask("first-room", "operator", "Fix without deployment", "operator", "operator");
  const child = await store.submit("first-room", "worker", "bounded work", "direct", 1, { taskId: "operator", original: "Fix without deployment", depth: 0, taskRef: ref });
  await store.decideTask(ref, 1, "operator-done-from-second-room", "close", "This topic is done");
  const reload = new ExecutionStore(file); await reload.load();
  assert.equal(reload.taskIsOpen(ref), false); assert.equal(reload.tasks()[0].operatorStatus, "done");
  await assert.rejects(reload.claim(child.id), /Operator task/);
  assert.equal(reload.list()[0].status, "ready", "closed order does not fabricate worker success/cancel effects");
});

test("plan and technical outcome commit atomically with durable turn settlement and survive a replay", async t => {
  const { store, file } = await storeFixture(t);
  const ref = await store.enrollTask("main", "operator", "Fix the owned deliverable", "operator", "operator");
  await store.beginTurn("turn-1", "main");
  await store.settleTurn("turn-1", "main", { outbox: [], consumed: [], taskOutcome: { ref, expectedRevision: 1, eventId: "turn-1", technical: { state: "open" }, plan: plan() } });
  const reload = new ExecutionStore(file); await reload.load();
  assert.equal(reload.turn("turn-1", "main")!.state, "settled"); assert.equal(reload.tasks()[0].plan!.length, 8);
  await assert.rejects(reload.settleTurn("turn-1", "main", { outbox: [], consumed: [] }), /already settled/);
  assert.equal(reload.tasks()[0].revision, 2);
});

test("late outcome after operator closure cannot overwrite closure or create todos", async t => {
  const { store } = await storeFixture(t);
  const ref = await store.enrollTask("main", "operator", "Fix", "operator", "operator");
  await store.beginTurn("working", "main"); await store.decideTask(ref, 1, "done", "close", "Done");
  await store.settleTurn("working", "main", { outbox: [], consumed: [], taskOutcome: { ref, expectedRevision: 1, eventId: "working", technical: { state: "completed" }, plan: plan() } });
  assert.equal(store.tasks()[0].operatorStatus, "done"); assert.equal(store.tasks()[0].technical.state, "unknown");
  assert.equal(store.tasks()[0].plan, undefined); assert.equal(store.turn("working", "main")!.state, "settled");
});

test("Core migration fences historical auto-resume before any validator call", async t => {
  const { store } = await storeFixture(t); let checks = 0, turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "should not run"; }), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => { checks++; return { state: "continue", next: "old instruction" }; } });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  h.restoreSessions([{ key: "main", tasks: [{ id: "old", original: "Done days ago", state: "active", depth: 0,
    recoveryEnrollment: "current", next: "repeat validation" }] }]);
  await h.recoverTasks(); await h.tick(); await h.drained();
  assert.equal(checks, 0); assert.equal(turns, 0); assert.equal(store.tasks()[0].operatorStatus, "unresolved");
});

test("simple Main task needs no Dispatcher or plan and closed authority survives session replacement", async t => {
  const { store, file } = await storeFixture(t); let turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "42"; }), executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => ({ state: "completed" }) });
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel()); t.after(() => h.stop(0));
  await h.submit({ ...msg("What is 6 × 7?"), id: "operator" }); await h.drained();
  assert.equal(turns, 1); const task = store.tasks()[0]; assert.equal(task.plan, undefined); assert.equal(task.technical.state, "completed");
  await h.operatorTaskDecision(task.id, "close", "explicit-done", "That's done", "other-room");
  const reload = new ExecutionStore(file); await reload.load(); assert.equal(reload.tasks()[0].operatorStatus, "done");
});

test("planned Main work commits and displays research/skill todos from the same stored outcome", async t => {
  const { store } = await storeFixture(t); let h!: Harness;
  const runtime = new FakeRuntime(() => {
    const input = h.sessions.get("mem:room1")!.current!;
    const task = store.tasks().find(t => t.id === input.taskRef!.id)!;
    const todos = plan(task.sources[0].id);
    todos[0] = { ...todos[0], status: "done", outcome: "Existing decision memory/1 read" };
    h.proposeTaskPlan("mem:room1", todos);
    return "Memory checked; implementation remains open.";
  });
  let checked = false;
  h = new Harness({ runtime, executionStore: store, taskLifecycle: { enabled: true }, completionCheck: async input => {
    checked = true; assert.equal(input.completionContext!.retained!.order!.plan!.length, 8);
    assert.equal(input.completionContext!.tasks.length, 1); assert.equal(input.completionContext!.recent.length, 0);
    return { state: "waiting" };
  } });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await h.submit({ ...msg("Implement a multi-step fix"), id: "operator" }); await h.drained();
  assert.equal(checked, true); assert.equal(store.tasks()[0].plan![0].status, "done");
  const text = channel.sent.map(s => s.text).join("\n"); assert.match(text, /\[x\] todo-0: memory-research/);
  assert.match(text, /skill-research/); assert.match(text, /internet-research/); assert.match(text, /skill-check/);
  assert.equal(channel.sent.filter(s => s.text.includes("Generation 1, Revision")).length, 1);
});

test("late child outcome for an operator-completed order is delivered as evidence without any Main or validator call", async t => {
  const { store } = await storeFixture(t);
  const ref = await store.enrollTask("mem:room1", "operator", "Existing task", "operator", "operator");
  const child = await store.submit("mem:room1", "worker", "work", "direct", 1, { taskId: "operator", original: "Existing task", depth: 0, taskRef: ref,
    anchor: { id: "operator", task: "Existing task", receivedAt: 1, replyTo: ROOM } });
  const running = await store.claim(child.id); await store.complete(child.id, running.token!, "Existing effect verified");
  await store.decideTask(ref, 1, "done", "close", "Done");
  const runtime = new FakeRuntime(() => assert.fail("closed order cannot start a model turn"));
  const h = new Harness({ runtime, executionStore: store, taskLifecycle: { enabled: true }, hostEventAllowed: () => true,
    completionCheck: async () => assert.fail("closed order cannot start a judge") });
  h.onStateChange = async () => {}; const channel = new MemoryChannel(); h.addChannel(channel); t.after(() => h.stop(0));
  await h.submit({ sessionKey: "mem:room1", source: "host", id: "late", hostEvent: { executionId: child.id }, text: "untrusted caller text", replyTo: ROOM });
  await h.drained(); assert.equal(runtime.sessions.size, 0); assert.equal(store.tasks()[0].operatorStatus, "done");
  assert.match(channel.sent[0].text, /Existing effect verified/); assert.doesNotMatch(channel.sent[0].text, /untrusted caller/);
});

test("reopened generation works from a new session without reviving old bound tasks", async t => {
  const { store } = await storeFixture(t);
  const ref = await store.enrollTask("old-room", "old", "Original request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, taskLifecycle: { enabled: true } });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await h.operatorTaskDecision(ref.id, "reopen", "fresh-operator", "Reopen the old topic", "new-room");
  assert.equal(store.taskIsOpen(ref), false);
  const task = h.state("new-room").task!; assert.equal(task.taskRef!.id, ref.id); assert.equal(task.taskRef!.generation, 2);
  assert.equal(store.taskBinding("old-room", "old")!.generation, 1); assert.equal(store.taskBinding("new-room", task.id)!.generation, 2);
});

test("failed Main turn cannot commit or display a staged plan", async t => {
  const { store } = await storeFixture(t); let h!: Harness;
  const runtime = new FakeRuntime(() => {
    const input = h.state("mem:room1").current!; const task = store.coreTask(input.taskRef!.id)!;
    h.proposeTaskPlan("mem:room1", plan(task.sources[0].id)); throw Error("real work failed");
  });
  h = new Harness({ runtime, executionStore: store, taskLifecycle: { enabled: true } });
  h.onStateChange = async () => {}; const channel = new MemoryChannel(); h.addChannel(channel); t.after(() => h.stop(0));
  await h.submit({ ...msg("Complex work"), id: "operator" }); await h.drained();
  assert.equal(store.tasks()[0].plan, undefined); assert.equal(store.tasks()[0].technical.state, "failed");
  assert.ok(!channel.sent.some(s => s.text.includes("todo-0")));
});

test("explicit order commands are idempotent and independent of Dispatcher or model review", async t => {
  const { store } = await storeFixture(t); const ref = await store.enrollTask("old-room", "operator", "Original", "operator", "operator");
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, taskLifecycle: { enabled: true } });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const plugins = new PluginHost(); await plugins.load([], { agent: "fixture", home: "/tmp", cwd: "/tmp" }, [], [],
    [taskLifecyclePlugin(h, async () => { assert.fail("command must not need model review"); })]);
  const command = plugins.commands.get("orders")!;
  await command.run(`done ${ref.id}`, { sessionKey: "second-room", inputId: "close-request" });
  await command.run(`done ${ref.id}`, { sessionKey: "second-room", inputId: "close-request" });
  assert.equal(store.coreTask(ref.id)!.revision, 2);
  await command.run(`reopen ${ref.id}`, { sessionKey: "second-room", inputId: "reopen-request" });
  await command.run(`reopen ${ref.id}`, { sessionKey: "second-room", inputId: "reopen-request" });
  assert.equal(store.coreTask(ref.id)!.generation, 2); assert.equal(h.state("second-room").tasks!.length, 1);
});

test("current Dispatcher worker tools are fenced immediately by operator closure", async t => {
  const { store } = await storeFixture(t);
  const ref = await store.enrollTask("parent", "operator", "work", "operator", "operator");
  const child = await store.submit("parent", "worker", "work", "direct", 1, { taskId: "operator", original: "work", depth: 0, taskRef: ref });
  const claim = await store.claim(child.id);
  const bridge = new DispatcherRuntime({} as Harness, store);
  bridge.beforeTurn(`dispatch:${child.id}:${claim.token}`);
  await store.decideTask(ref, 1, "done", "close", "Stop pursuing this topic");
  assert.throws(() => bridge.guardTool(`dispatch:${child.id}:${claim.token}`, "write"), /Operator task/);
  assert.equal(store.list()[0].status, "running", "unknown in-flight effects remain recorded, never declared undone");
});
