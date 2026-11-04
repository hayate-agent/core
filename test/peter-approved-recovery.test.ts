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
  t.after(() => rm(dir, { recursive: true, force: true }));
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
  h.restoreSessions([{ key: "mem:room1", task: parent }]); t.after(() => h.stop(0));
  return { h, store, runtime, ch, child, calls: () => calls, advance: () => { now += 60000; },
    assess: (fn: typeof assess) => { assess = fn; }, task: () => h.snapshotSessions()[0].tasks![0] };
}

test("technical dependency hold retries only bounded durable assessment; successful admission runs one approved next step", async t => {
  const f = await fixture(t);
  await f.h.recoverTasks(); assert.equal(f.calls(), 1);
  assert.equal(f.task().supervisorDecision?.diagnostic, "technical");
  assert.equal(f.task().recoveryRetry?.attempts, 1);
  assert.ok((JSON.stringify(f.h.outboxEntries()) + f.ch.texts().join(" ")).includes("technisch fehlgeschlagen"));
  assert.ok(!(JSON.stringify(f.h.outboxEntries()) + f.ch.texts().join(" ")).includes("nicht konfiguriert"));
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
  for (let i = 0; i < 100 && !f.runtime.sessions.get("mem:room1")?.prompts.length; i++) { await f.h.tick(); await new Promise(r => setTimeout(r, 5)); }
  assert.equal(f.runtime.sessions.get("mem:room1")?.prompts.length, 1, JSON.stringify({ sessions: f.h.snapshotSessions(), pending: f.h.pendingInputs(), opened: f.runtime.opened }));
  assert.equal(f.store.list("mem:room1")[0].status, "blocked");
  assert.equal(f.store.list("mem:room1")[0].restarts, 0);
});

test("legacy technical hold without retry metadata gets a bounded assessment, not worker replay", async t => {
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

test("missing completion backend is visible once, stops after three attempts, never replays worker", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++) { await f.h.recoverTasks(); f.advance(); }
  assert.equal(f.calls(), 3);
  assert.equal(f.task().recoveryRetry?.attempts, 3);
  const notices = [...f.h.outboxEntries().map(x => x.text), ...f.ch.texts()].filter(x => x.includes("Recovery angehalten"));
  // One technical diagnostic, then one distinct terminal exhaustion notice.
  assert.equal(notices.length, 2);
  assert.equal(notices.filter(x => x.includes("ausgeschöpft")).length, 1);
  assert.equal(f.task().termination, "recovery_assessment_failed");
  assert.equal(f.runtime.opened.length, 0);
  assert.equal(f.store.list("mem:room1")[0].status, "blocked");
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
  assert.equal(f.store.list("mem:room1")[0].status, "blocked");
});
