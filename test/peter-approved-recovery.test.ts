import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, type DurableTask } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

async function fixture(t: { after(fn: () => Promise<void>): void }, original = "Approved: locate the QA host; do not execute imports") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "peter-recovery-"));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("mem:room1", "child", "Inspect existing deployment evidence", "direct", 1,
    { taskId: "parent", depth: 0, original });
  const claim = await store.claim(child.id);
  await store.intent(child.id, claim.token!, "uncertain-effect", "unsafe");
  await store.fail(child.id, claim.token!, "worker-failed");
  let now = 1000, calls = 0;
  const runtime = new FakeRuntime(() => { h.planContinuation("mem:room1", { state: "waiting" }); return "Independent host evidence checked; no import executed."; });
  let assess: NonNullable<ConstructorParameters<typeof Harness>[0]["completionCheck"]> = async () => { throw Error("backend unavailable"); };
  // Technical diagnostics are opt-in (PR246); these tests assert their content.
  const h = new Harness({ runtime, executionStore: store, now: () => now, tickMs: 60000, gateways: { recoveryDiagnostics: true } as never,
    completionCheck: async (...args) => { calls++; return assess(...args); } });
  h.home = { channel: "mem", target: "room1" };
  const ch = new MemoryChannel(); h.addChannel(ch); h.onStateChange = async () => {};
  const parent: DurableTask = { id: "parent", original, state: "blocked", depth: 0, expiresAt: 500000,
    anchor: { id: "parent", task: original, receivedAt: 1, replyTo: { channel: "mem", target: "room1" } } };
  h.restoreSessions([{ key: "mem:room1", task: parent }]);
  t.after(async () => { await h.stop(0, 10000); await store.drain(); await rm(dir, { recursive: true, force: true }); });
  return { h, store, runtime, ch, child, calls: () => calls, advance: () => { now += 60000; },
    assess: (fn: typeof assess) => { assess = fn; }, task: () => h.snapshotSessions()[0].tasks![0] };
}

test("technical dependency hold retries durable read-only assessment; successful admission runs one approved next step", async t => {
  const f = await fixture(t);
  await f.h.recoverTasks(); assert.equal(f.calls(), 1);
  assert.equal(f.task().supervisorDecision?.diagnostic, "technical");
  assert.equal(f.task().recoveryRetry?.attempts, 1);
  assert.ok((JSON.stringify(f.h.outboxEntries()) + f.ch.texts().join(" ")).includes("failed technically"));
  assert.ok(!(JSON.stringify(f.h.outboxEntries()) + f.ch.texts().join(" ")).includes("not configured"));
  await f.h.recoverTasks(); assert.equal(f.calls(), 1);
  f.h.restoreSessions([{ key: "mem:room1", task: structuredClone(f.task()) }]);
  f.advance();
  f.assess(async input => {
    assert.equal(input.completionAnchor?.task, f.task().original);
    assert.equal(input.continuationExpiresAt, 500000);
    return { state: "continue", next: "Check a different read-only host inventory source", expiresAt: 400000 };
  });
  await f.h.recoverTasks(); assert.equal(f.calls(), 2);
  assert.equal(f.task().recoveryRetry, undefined);
  assert.equal(f.task().expiresAt, 400000);
  await f.h.start(); f.h.releaseRestored(); await f.h.tick();
  for (let i = 0; i < 1000 && !f.runtime.sessions.get("mem:room1")?.prompts.length; i++) { await f.h.tick(); await new Promise(r => setTimeout(r, 5)); }
  assert.equal(f.runtime.sessions.get("mem:room1")?.prompts.length, 1, JSON.stringify({ sessions: f.h.snapshotSessions(), pending: f.h.pendingInputs(), opened: f.runtime.opened }));
  assert.equal(f.store.list("mem:room1")[0].status, "blocked");
  assert.equal(f.store.list("mem:room1")[0].restarts, 0);
});

test("legacy technical hold without retry metadata gets a deferred assessment, not worker replay", async t => {
  const f = await fixture(t);
  const task = structuredClone(f.task());
  task.supervisorDecision = { verdict: "blocked", diagnostic: "technical", dependencyHold: { reason: "global-hold", evidence: "legacy" } };
  task.recoveryAttentionId = "already-delivered";
  f.h.restoreSessions([{ key: "mem:room1", task }]);
  await f.h.recoverTasks(); await f.h.recoverTasks();
  assert.equal(f.calls(), 1);
  assert.equal(f.task().recoveryRetry?.attempts, 1);
  assert.equal(f.h.outboxEntries().length + f.ch.texts().length, 0);
  assert.equal(f.runtime.opened.length, 0);
});

test("missing completion backend is visible once, backs off without terminal exhaustion, never replays worker", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) { await f.h.recoverTasks(); f.advance(); }
  assert.equal(f.calls(), 3);
  assert.equal(f.task().recoveryRetry?.attempts, 3);
  const notices = [...f.h.outboxEntries().map(x => x.text), ...f.ch.texts()].filter(x => x.includes("Recovery assessment paused:"));
  // Six one-minute ticks produce only three checks (1m, 2m, 4m backoff), not six.
  assert.equal(notices.length, 1);
  assert.equal(notices.filter(x => x.includes("budget is exhausted")).length, 0);
  assert.equal(f.task().termination, undefined);
  assert.equal(f.runtime.opened.length, 0);
  assert.equal(f.store.list("mem:room1")[0].status, "blocked");
});

test("five failed dependency checks survive restart; sixth admits independent work without replaying child", async t => {
  const f = await fixture(t);
  const initial = f.task(); initial.expiresAt = 10_000_000;
  f.h.restoreSessions([{ key: "mem:room1", task: initial }]);
  for (let i = 0; i < 31; i++) { await f.h.recoverTasks(); f.advance(); }
  assert.equal(f.calls(), 5);
  assert.equal(f.task().termination, undefined);
  const due = f.task().recoveryRetry!.nextAt;
  const original = f.task().original;
  const sessions = JSON.parse(JSON.stringify(f.h.snapshotSessions()));
  const child = JSON.stringify(f.store.list());
  await f.h.stop(0);
  let now = due - 1, checks = 0, turns = 0;
  let h: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => {
    turns++; h.planContinuation("mem:room1", { state: "waiting" }); return "Independent authorized evidence checked";
  }), executionStore: f.store, now: () => now, tickMs: 600000,
    completionCheck: async input => {
      checks++; assert.equal(input.completionAnchor?.task, original);
      if (turns) return { state: "waiting" };
      return { state: "continue", next: "Read independent host evidence; do not import or replay child" };
    } });
  h.addChannel(f.ch); h.onStateChange = async () => {};
  h.restoreSessions(sessions);
  try {
    await h.recoverTasks(); assert.equal(checks, 0);
    now = due; await h.recoverTasks(); h.releaseRestored(); await h.drained();
    assert.equal(checks, 2); assert.equal(turns, 1);
    assert.equal(JSON.stringify(f.store.list()), child, "unknown child effects remain execution-fenced");
  } finally { await h.stop(0); }
});

for (const boundary of ["approval", "expiry", "stop"] as const) test(`${boundary} remains binding after a technical hold`, async t => {
  const f = await fixture(t, boundary === "approval" ? "Propose an approach; implement only after approval" : undefined);
  await f.h.recoverTasks(); f.advance();
  if (boundary === "expiry" || boundary === "stop") {
    const task = structuredClone(f.task());
    if (boundary === "expiry") task.expiresAt = 1001;
    else { task.state = "stopped"; task.termination = "operator_stop" as DurableTask["termination"]; }
    f.h.restoreSessions([{ key: "mem:room1", task }]);
  }
  f.assess(async input => {
    assert.equal(input.completionAnchor?.task, "Propose an approach; implement only after approval");
    return { state: "waiting", next: "Await operator approval" };
  });
  await f.h.recoverTasks(); await f.h.tick(); await f.h.drained();
  assert.equal(f.calls(), boundary === "approval" ? 2 : 1);
  assert.equal(f.runtime.opened.length, 0);
  assert.equal(f.store.list("mem:room1")[0].status, boundary === "stop" ? "cancelled" : "blocked");
});
