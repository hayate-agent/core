import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "mem:room1";
const delay = () => new Promise(resolve => setImmediate(resolve));
const task = (id: string, extra: Partial<DurableTask> = {}): DurableTask => ({ id, original: `authorized ${id}`, state: "active", depth: 0,
  recoveryEnrollment: "current", anchor: { id, task: `authorized ${id}`, receivedAt: 1000 }, ...extra });
function restore(h: Harness, tasks: DurableTask[]) {
  h.addChannel(new MemoryChannel()); h.restoreSessions([{ key, replyTo: { channel: "mem", target: "room1" }, tasks, task: tasks[0] }]);
  h.onStateChange = async () => {};
}
async function idle(h: Harness) { for (let i = 0; i < 30; i++) { await delay(); if (h.isDrained()) return; } throw Error("fixture not drained"); }

test("restart reassesses enrolled timerless wait and continues without any new user input", async t => {
  let work = 0, assessments = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { work++; return "verified"; }), now: () => 2000,
    completionCheck: async input => { assessments++; return input.continuationDepth ? { state: "completed" } : { state: "continue", next: "verify saved work" }; } });
  t.after(() => h.stop(0)); restore(h, [task("original", { state: "waiting", explicitBlocked: false, expiresAt: 50000, lastReply: "Update scheduled; verify activation after restart" })]);
  await h.recoverTasks(); assert.equal(work, 0); assert.equal(h.pendingInputs().length, 1);
  h.releaseRestored(); await idle(h);
  assert.equal(work, 1); assert.equal(assessments, 2);
  assert.equal(h.state(key).task!.id, "original"); assert.equal(h.state(key).task!.expiresAt, 50000);
});

test("non-decision during restart retains automatic assessment backoff, then resumes on timer alone", async t => {
  let now = 2000, work = 0, probes = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { work++; return "verified"; }), now: () => now,
    completionCheck: async (input, _reply, _signal, diagnostic) => {
      if (input.continuationDepth) return { state: "completed" };
      if (++probes === 1) { diagnostic?.("unavailable"); return; }
      return { state: "continue", next: "verify remaining work" };
    } });
  t.after(() => h.stop(0)); restore(h, [task("original", { next: "saved proposal" })]);
  await h.recoverTasks(); h.releaseRestored();
  const saved = h.state(key).task!; assert.equal(saved.state, "active"); assert.ok(saved.recoveryRetry);
  assert.equal(work, 0); await h.tick(); assert.equal(probes, 1);
  now = saved.recoveryRetry!.nextAt; await h.tick(); await idle(h);
  assert.equal(work, 1); assert.equal(probes, 2); assert.equal(h.state(key).task!.state, "completed");
});

test("due post-restart verification is not starved by another task's continuous turns", async t => {
  let now = 2000; const order: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(() => { const id = h.state(key).current!.taskId!; order.push(id); now += 1000; return "verified bounded slice"; }), now: () => now,
    completionCheck: async input => {
      if (input.taskId === "update-verification" && !input.continuationDepth) return { state: "continue", next: "verify actual running update" };
      return input.taskId === "other" && order.filter(x => x === "other").length < 3
        ? { state: "continue", next: "next bounded slice" } : { state: "completed" };
    } });
  t.after(() => h.stop(0));
  const first = task("other", { next: "next bounded slice", recoveryAdmission: { id: "task:other:1", depth: 1, next: "next bounded slice", original: "authorized other" } });
  restore(h, [first, task("update-verification", { next: "verify activation", recoveryAssessment: "claimed", recoveryRetry: { attempts: 1, nextAt: 2500, diagnostic: "unavailable" } })]);
  await h.recoverTasks(); h.releaseRestored(); await idle(h);
  assert.ok(order.indexOf("update-verification") >= 0, `verification was not scheduled: ${order}`);
  assert.ok(order.indexOf("update-verification") < order.lastIndexOf("other"), `verification waited until unrelated work ended: ${order}`);
  assert.equal(h.state(key).tasks!.find(x => x.id === "update-verification")!.state, "completed");
});

test("legacy unresolved diagnostic is re-enrolled only for independent assessment, not productive replay", async t => {
  let now = 2000, checks = 0, work = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { work++; return "verified"; }), now: () => now,
    completionCheck: async input => { checks++; return input.continuationDepth ? { state: "completed" } : { state: "continue", next: "reconcile retained work" }; } });
  t.after(() => h.stop(0)); restore(h, [task("original", { state: "blocked", explicitBlocked: false,
    next: "retained proposal", recoveryAssessment: "decided", supervisorDecision: { verdict: "unresolved", diagnostic: "unavailable" } })]);
  await h.recoverTasks(); h.releaseRestored(); assert.equal(work, 0); assert.equal(checks, 0);
  now = h.state(key).task!.recoveryRetry!.nextAt; await h.tick(); await idle(h);
  assert.equal(work, 1); assert.equal(h.state(key).task!.id, "original");
});

test("recorded non-decision block is reassessed from exact newly readable history without treating prose as a resume grant", async t => {
  let reads = 0, checks = 0, work = 0;
  const runtime = Object.assign(new FakeRuntime(() => { work++; return "Remaining authorized check verified"; }), {
    retainedSessionHistory: async () => { reads++; return { sessionId: "retained", entries: [{ id: "operator", role: "user", text: "authorized original" }, { id: "facts", role: "assistant", text: "retained scoped evidence" }] }; },
  });
  const h = new Harness({ runtime, now: () => 2000, currentRuntime: { version: "0.1.270", revision: "a".repeat(40), startedAt: 2000 }, completionCheck: async input => {
    checks++; return work ? { state: "completed" } : { state: "continue", next: "read-only verification under original scope" };
  } });
  t.after(() => h.stop(0)); restore(h, [task("original", { state: "blocked", explicitBlocked: false, depth: 3, expiresAt: 500000,
    next: "old proposal is NOT a grant", recoveryAssessment: "decided", supervisorDecision: { verdict: "unresolved", diagnostic: "inconclusive" } })]);
  await h.recoverTasks(); assert.ok(reads > 0); assert.equal(checks, 1); assert.equal(work, 0); assert.equal(h.pendingInputs().length, 1);
  h.releaseRestored(); await idle(h); assert.equal(work, 1); assert.equal(h.state(key).task!.id, "original"); assert.equal(h.state(key).task!.expiresAt, 500000);
});

test("non-decision repair cannot revive semantic blockers, explicit stops, old history or absent evidence", async t => {
  let checks = 0;
  const h = new Harness({ runtime: new FakeRuntime(), now: () => 2000, completionCheck: async () => { checks++; throw Error("must not infer a grant"); } });
  t.after(() => h.stop(0));
  const base = { state: "blocked" as const, explicitBlocked: false, next: "saved proposal", recoveryAssessment: "decided" as const,
    supervisorDecision: { verdict: "unresolved" as const, diagnostic: "inconclusive" as const } };
  restore(h, [task("no-history", base), task("semantic", { ...base, supervisorDecision: { verdict: "blocked" } }),
    task("explicit", { ...base, explicitBlocked: true }), task("historical", { ...base, recoveryEnrollment: "held-legacy" }),
    task("expired", { ...base, expiresAt: 1000 }), task("stopped", { ...base, state: "stopped" })]);
  await h.recoverTasks(); assert.equal(checks, 0); assert.equal(h.pendingInputs().length, 0);
  assert.equal(h.state(key).tasks!.find(task => task.id === "no-history")!.state, "blocked");
});

test("a mandate expiring during read-only non-decision reconciliation stays held", async t => {
  let now = 2000, checks = 0;
  const runtime = Object.assign(new FakeRuntime(), { retainedSessionHistory: async () => { now = 3000; return { sessionId: "retained", entries: [{ id: "facts", role: "assistant", text: "retained" }] }; } });
  const h = new Harness({ runtime, now: () => now, completionCheck: async () => { checks++; return { state: "continue", next: "must not admit" }; } });
  t.after(() => h.stop(0)); restore(h, [task("expired-during-read", { state: "blocked", explicitBlocked: false, expiresAt: 2500,
    next: "saved", recoveryAssessment: "decided", supervisorDecision: { verdict: "unresolved", diagnostic: "inconclusive" } })]);
  await h.recoverTasks(); assert.equal(checks, 0); assert.equal(h.state(key).task!.state, "blocked"); assert.equal(h.pendingInputs().length, 0);
});

test("startup wait assessment deferred by another restored task remains scheduled at the next boundary", async t => {
  const order: string[] = [];
  const h = new Harness({ runtime: new FakeRuntime(() => { order.push(h.state(key).current!.taskId!); return "verified"; }),
    completionCheck: async input => input.continuationDepth ? { state: "completed" } : { state: "continue", next: "verify retained work" } });
  t.after(() => h.stop(0));
  const first = task("other", { next: "first step", recoveryAdmission: { id: "first", depth: 1, original: "authorized other", next: "first step" } });
  restore(h, [first, task("waiting", { state: "waiting", explicitBlocked: false })]);
  await h.recoverTasks(); await h.recoverTasks(); h.releaseRestored(); await idle(h);
  assert.deepEqual(order, ["other", "waiting"]);
});

test("restart preserves manual stop, explicit blocker, paused host, genuine timer and legacy hold", async t => {
  const cases = [task("stopped", { state: "stopped" }), task("completed", { state: "completed" }),
    task("blocked", { state: "blocked", explicitBlocked: true }), task("legacy", { state: "waiting", recoveryEnrollment: "held-legacy" }),
    task("expired", { state: "waiting", expiresAt: 1000 }),
    task("timer", { state: "waiting", wait: { reason: "external dependency", nextAt: 9000, deadline: 12000 }, next: "read-only check" })];
  let checks = 0; const h = new Harness({ runtime: new FakeRuntime(() => { throw Error("no work allowed"); }), now: () => 2000,
    completionCheck: async () => { checks++; return { state: "continue", next: "not authorized" }; } });
  t.after(() => h.stop(0)); restore(h, cases); await h.recoverTasks(); h.releaseRestored(); await idle(h); assert.equal(checks, 0);
  const paused = new Harness({ runtime: new FakeRuntime(), completionCheck: async () => { throw Error("paused must not assess"); } });
  t.after(() => paused.stop(0)); restore(paused, [task("paused", { state: "waiting" })]); paused.paused = true;
  await paused.recoverTasks(); paused.releaseRestored(); assert.equal(paused.pendingInputs().length, 0); assert.equal(paused.paused, true);
});
