import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, type DurableTask } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
const to = { channel: "mem", target: "room1" };

async function blockedChild(store: ExecutionStore, request: string) {
  const child = await store.submit(key, request, `Legacy worker ${request}`, "direct", 1);
  const claim = await store.claim(child.id);
  await store.intent(child.id, claim.token!, `effect-${request}`, "unsafe");
  await store.fail(child.id, claim.token!, "worker-failed");
  return child.id;
}

async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "legacy-unscoped-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const ids = [await blockedChild(store, "tickets-1423"), await blockedChild(store, "tickets-1625"), await blockedChild(store, "tickets-1725")];
  return { store, ids, before: JSON.stringify(store.list(key)) };
}

function harness(store: ExecutionStore, clock: { now: number }, answer: (h: Harness, text: string) => string,
  // Assessor confirms the turn's own plan; it never invents work.
  assess: (input: import("../src/types.js").Inbound) => unknown = input => input.continuation ?? { state: "completed" }) {
  let h!: Harness; let checks = 0;
  const runtime = new FakeRuntime(text => answer(h, text));
  h = new Harness({ runtime, executionStore: store, now: () => clock.now, tickMs: 60000,
    completionCheck: async input => { checks++; return assess(input) as never; } });
  h.home = to;
  const ch = new MemoryChannel(); h.addChannel(ch);
  let saved: ReturnType<Harness["snapshotSessions"]> = [];
  let pending: ReturnType<Harness["pendingInputs"]> = [];
  h.onStateChange = async () => { saved = structuredClone(h.snapshotSessions()); pending = structuredClone(h.pendingInputs()); };
  return { h, ch, runtime, checks: () => checks, saved: () => saved, pending: () => pending };
}

const legacyTask = (): DurableTask => ({ id: "legacy-A", original: "Old Peter mandate that may own the workers", state: "blocked", depth: 0,
  next: "Old next step", expiresAt: 900000000 });

test("new task B created after 3 unscoped legacy children continues and executes its approved next step; legacy task A stays held", async t => {
  const { store, ids, before } = await fixture(t);
  const clock = { now: 1000 };
  const turns: string[] = [];
  const f = harness(store, clock, (h, text) => {
    turns.push(text);
    if (text.includes("Run step two")) { h.planContinuation(key, { state: "completed" }); return "step two done"; }
    h.planContinuation(key, { state: "continue", next: "Run step two" }); return "step one done";
  });
  f.h.restoreSessions([{ key, replyTo: to, tasks: [legacyTask()] }]);
  t.after(() => f.h.stop(0));
  await f.h.recoverTasks(); await f.h.start(); f.h.releaseRestored();
  await f.h.tick(); await f.h.drained();
  await f.h.submit({ ...msg("New task B: do step one then step two", "@owner:x", key), id: "B" });
  for (let i = 0; i < 5; i++) { clock.now += 60000; await f.h.tick(); await f.h.drained(); }

  assert.equal(turns.length, 2, JSON.stringify(turns));
  assert.match(turns[1]!, /Run step two/);
  const tasks = f.h.snapshotSessions()[0]!.tasks!;
  const b = tasks.find(task => task.id === "B")!;
  assert.equal(b.state, "completed");
  assert.deepEqual(b.preexistingUnscoped, [...ids].sort());
  const a = tasks.find(task => task.id === "legacy-A")!;
  assert.equal(a.state, "blocked", "same/unclear-origin task remains fenced");
  assert.equal(a.recoveryAdmission, undefined);
  assert.equal(a.preexistingUnscoped, undefined);
  assert.match(a.dependencyAttentionId ?? "", /^task-dependency-unscoped:/);
  // Warning stays: exactly one actionable unknown-effects notice naming all three.
  const notices = f.ch.sent.filter(m => m.text.includes("ohne Aufgabenzuordnung"));
  assert.equal(notices.length, 1);
  for (const id of ids) assert.match(notices[0]!.text, new RegExp(id));
  assert.match(notices[0]!.text, /Effekte sind unbekannt/);
  // Legacy workers: byte-identical, no claims, intents, cancels or new executions.
  assert.equal(JSON.stringify(store.list(key)), before);
});

test("unscoped child appearing after B was created still blocks B (conservative)", async t => {
  const { store } = await fixture(t);
  const clock = { now: 1000 };
  let late: string | undefined;
  const turns: string[] = [];
  const f = harness(store, clock, (h, text) => {
    turns.push(text);
    h.planContinuation(key, { state: "continue", next: "Run step two" }); return "step one done";
  });
  f.h.restoreSessions([{ key, replyTo: to, tasks: [] }]);
  t.after(() => f.h.stop(0));
  await f.h.start(); f.h.releaseRestored();
  const orig = f.h.onStateChange!;
  // Simulate an unscoped child (no dependency) submitted during B's turn.
  f.h.onStateChange = async () => { if (!late && f.h.snapshotSessions()[0]?.tasks?.some(x => x.id === "B")) late = await blockedChild(store, "late"); await orig(); };
  await f.h.submit({ ...msg("New task B", "@owner:x", key), id: "B" });
  for (let i = 0; i < 5; i++) { clock.now += 60000; await f.h.tick(); await f.h.drained(); }
  assert.ok(late);
  const b = f.h.snapshotSessions()[0]!.tasks!.find(task => task.id === "B")!;
  assert.ok(!b.preexistingUnscoped?.includes(late!));
  assert.equal(turns.length, 1, "late unscoped child fences B's next step");
  assert.notEqual(b.state, "completed");
  assert.equal(f.h.pendingInputs().length, 0);
  assert.equal(b.state, "blocked");
  assert.match(b.dependencyAttentionId ?? "", /^task-dependency-unscoped:/);
  const notice = f.ch.sent.find(m => m.text.includes("ohne Aufgabenzuordnung"));
  assert.ok(notice && notice.text.includes(late!) && /\/dispatch cancel/.test(notice.text), "actionable unknown-effects report");
});

test("B's preserved preexisting set survives crash/restart; queued step runs exactly once, legacy workers untouched", async t => {
  const { store, before } = await fixture(t);
  const clock = { now: 1000 };
  const first: string[] = [], second: string[] = [];
  const answer = (log: string[]) => (h: Harness, text: string) => {
    log.push(text);
    if (text.includes("Run step two")) { h.planContinuation(key, { state: "completed" }); return "step two done"; }
    h.planContinuation(key, { state: "continue", next: "Run step two" }); return "step one done";
  };
  const a = harness(store, clock, answer(first));
  // Crash point: the durable checkpoint that holds B's queued, not-yet-started next step.
  let crash: { sessions: ReturnType<Harness["snapshotSessions"]>; pending: ReturnType<Harness["pendingInputs"]> } | undefined;
  a.h.onStateChange = async () => {
    const pending = a.h.pendingInputs();
    if (!crash && pending.some(x => x.taskId === "B" && x.continuationDepth === 1 && !x.started))
      crash = structuredClone({ sessions: a.h.snapshotSessions(), pending });
  };
  a.h.restoreSessions([{ key, replyTo: to, tasks: [] }]);
  await a.h.start(); a.h.releaseRestored();
  await a.h.submit({ ...msg("New task B", "@owner:x", key), id: "B" });
  await a.h.drained(); await a.h.stop(0);
  // The process "dies" at the captured checkpoint; anything after it is lost.
  assert.ok(crash, "B's next step was durably queued");
  assert.equal(crash!.sessions[0]!.tasks!.find(x => x.id === "B")!.preexistingUnscoped?.length, 3);

  const b = harness(store, clock, answer(second));
  b.h.restoreSessions(crash!.sessions); b.h.restorePending(crash!.pending);
  t.after(() => b.h.stop(0));
  await b.h.recoverTasks(); await b.h.start(); b.h.releaseRestored();
  for (let i = 0; i < 5; i++) { clock.now += 60000; await b.h.tick(); await b.h.drained(); }
  assert.equal(second.filter(x => x.includes("Run step two")).length, 1, JSON.stringify(second));
  assert.equal(b.h.snapshotSessions()[0]!.tasks!.find(x => x.id === "B")!.state, "completed");
  assert.equal(JSON.stringify(store.list(key)), before, "no claim/intent/cancel/new execution for legacy workers");
});

test("stop and deadline remain binding for B despite isolation", async t => {
  for (const mode of ["stop", "deadline"] as const) {
    const { store, before } = await fixture(t);
    const clock = { now: 1000 };
    const turns: string[] = [];
    const f = harness(store, clock, (h, text) => {
      turns.push(text);
      if (mode === "stop") void h.stopConversation(key);
      h.planContinuation(key, { state: "continue", next: "Run step two" });
      if (mode === "deadline") clock.now += 10; // the fixed deadline passes before the step could run
      return "step one done";
    }, mode === "deadline" ? () => ({ state: "continue", next: "Run step two", expiresAt: 1005 }) : undefined);
    f.h.restoreSessions([{ key, replyTo: to, tasks: [] }]);
    await f.h.start(); f.h.releaseRestored();
    await f.h.submit({ ...msg("New task B", "@owner:x", key), id: "B" });
    for (let i = 0; i < 5; i++) { clock.now += 60000; await f.h.tick(); await f.h.drained(); }
    assert.equal(turns.filter(x => x.includes("Run step two")).length, 0, mode);
    if (mode === "deadline") assert.equal(JSON.stringify(store.list(key)), before);
    await f.h.stop(0);
  }
});

test("malformed persisted preexisting set fails closed", async t => {
  const { store, ids } = await fixture(t);
  const clock = { now: 1000 };
  const f = harness(store, clock, () => "must not run");
  const task: DurableTask = { ...legacyTask(), id: "C", state: "active", preexistingUnscoped: ids.join(",") as never };
  f.h.restoreSessions([{ key, replyTo: to, tasks: [task] }]);
  t.after(() => f.h.stop(0));
  await f.h.recoverTasks(); await f.h.start(); f.h.releaseRestored();
  for (let i = 0; i < 3; i++) { clock.now += 60000; await f.h.tick(); await f.h.drained(); }
  assert.equal(f.runtime.opened.length, 0);
  assert.equal(f.h.snapshotSessions()[0]!.tasks![0]!.state, "blocked");
});


test("restored channel input without task provenance never captures old workers as unrelated", async t => {
  const {store,before}=await fixture(t); const clock={now:1000};
  const f=harness(store,clock,(h)=>{h.planContinuation(key,{state:"continue",next:"Repeat potentially related work"});return "partial";},()=>({state:"blocked",reason:"Relationship unknown"}));
  t.after(()=>f.h.stop(0));
  f.h.restoreSessions([{key,replyTo:to,tasks:[]}]);
  f.h.restorePending([{...msg("Retained old task", "@owner:x",key),id:"restored-old"}]);
  await f.h.start();f.h.releaseRestored();await f.h.drained();await f.h.tick();await f.h.drained();
  const task=f.h.snapshotSessions()[0]!.tasks!.find(x=>x.id==="restored-old")!;
  assert.equal(task.preexistingUnscoped,undefined);
  assert.equal(f.h.pendingInputs().length,0);
  assert.equal(JSON.stringify(store.list(key)),before);
});
