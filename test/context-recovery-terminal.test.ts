import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, contextPolicy, MaintenanceError, MAX_RECOVERY_FAILURES } from "../src/context-maintenance.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { RuntimeSession } from "../src/types.js";

async function fixture(t: { after(fn: () => Promise<unknown>): void }, autoHandover = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), "recovery-terminal-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = 10000, seeds = 0, fail = true;
  const create = () => new ContextMaintenance(home, () => contextPolicy({ autoHandover }), undefined, () => now);
  const old = { status: () => ({ sessionId: "old", contextPercent: 20 }), archiveEntries: () => [], summarize: async () => "CURRENT STATE AND NEXT STEPS: preserve operator intent" } as unknown as RuntimeSession;
  const next = { status: () => ({ sessionId: "new", contextPercent: 20 }), seedHandover: async () => {
    seeds++; if (fail) throw new MaintenanceError("seed", "EIO");
  } } as unknown as RuntimeSession;
  const m = create();
  const request = { action: "handover" as const, preserve: "operator correction", resume: "next authorized step" };
  await m.admit("chat", "initial", request);
  m.archives.link = async () => { throw new MaintenanceError("archive-link", "EIO"); };
  await m.beforeTurn("chat", old, async () => next, { channel: "mem", target: "room1" });
  return { home, create, old, next, request, m, seeds: () => seeds, succeed: () => { fail = false; },
    advance: (n: number) => { now += n; }, due: async (maintenance: ContextMaintenance) => { now = (await maintenance.status("chat")).recovery!.notBefore!; } };
}

for (const entry of ["beforeTurn", "guidance", "prepared-old"] as const) test(`${entry}: actual failures exhaust once, guards/restarts/arrivals retain deadline, intent and operation`, async t => {
  const f = await fixture(t);
  let m = f.create();
  const id = (await m.status("chat")).recovery!.id;
  const run = () => entry === "guidance" ? m.guidance("chat", f.next) : m.beforeTurn("chat", entry === "prepared-old" ? f.old : f.next, async handover => {
    await f.next.seedHandover!(handover!.text); return f.next;
  });
  for (let count = 1; count <= MAX_RECOVERY_FAILURES; count++) {
    const checkpoint = await m.status("chat");
    assert.equal(checkpoint.recovery!.failedAttempts, count);
    assert.equal(checkpoint.recovery!.id, id);
    for (let arrival = 0; arrival < 4; arrival++) {
      await run();
      await m.boundary("chat", f.next, async () => { throw Error("guard must not rotate"); });
      await m.prepareContinuation("chat", f.next, async () => { throw Error("guard must not rotate"); }, "compact", "different arrival", "do not reset");
      await assert.rejects(m.request("chat", f.request), /versioned/);
      assert.deepEqual((await m.status("chat")).recovery, checkpoint.recovery);
      assert.deepEqual((await m.status("chat")).pending, f.request);
      m = f.create();
    }
    if (count === MAX_RECOVERY_FAILURES) break;
    await f.due(m); await run();
  }
  const terminal = await m.recoveryStatus("chat");
  assert.equal(terminal?.state, "blocked"); assert.equal(terminal?.reason, "exhausted");
  assert.equal(f.seeds(), MAX_RECOVERY_FAILURES - 1);
  f.advance(86400000);
  await run();
  assert.deepEqual(await m.recoveryStatus("chat"), terminal);
  assert.equal(f.seeds(), MAX_RECOVERY_FAILURES - 1);
  const notices: string[] = [];
  await m.flushNotices(async n => { notices.push(n.text); });
  assert.equal(notices.length, 2, "one waiting notice and one terminal notice, not one per retry");
});

test("success closes same operation; explicit versioned recovery retains lifetime count and idempotent receipts", async t => {
  const f = await fixture(t); const m = f.create();
  for (let i = 1; i < MAX_RECOVERY_FAILURES; i++) { await f.due(m); await m.guidance("chat", f.next); }
  const failed = (await m.status("chat")).recovery!;
  await assert.rejects(m.admit("chat", "reopen", f.request, 0), /version conflict/);
  await m.admit("chat", "initial", f.request, 0); // same receipt is NOT recovery authority
  assert.equal((await m.recoveryStatus("chat"))?.state, "blocked");
  await assert.rejects(m.cancelAdmission("chat", "initial", 1), /cannot be cancelled/);
  await m.admit("chat", "reopen", f.request, 1);
  f.succeed();
  await m.guidance("chat", f.next);
  const applied = await m.status("chat");
  assert.equal(applied.recovery!.id, failed.id);
  assert.equal(applied.recovery!.failedAttempts, MAX_RECOVERY_FAILURES);
  assert.equal(applied.recovery!.state, "applied");
  assert.equal(applied.recoveryRetry, undefined);
  assert.equal(applied.pending, undefined);
  assert.equal(applied.admission?.execution, "applied");
  assert.equal(await m.recoveryStatus("chat"), undefined);
});

test("notice delivery retry retains ID and never repeats compaction/seed", async t => {
  const f = await fixture(t);
  let receipt = "";
  await assert.rejects(f.m.flushNotices(async n => { receipt = n.id; throw Error("offline"); }));
  const before = await f.m.status("chat");
  await f.create().flushNotices(async n => { assert.equal(n.id, receipt); });
  await f.create().flushNotices(async () => { assert.fail("duplicate delivery"); });
  assert.equal(f.seeds(), 0);
  assert.deepEqual((await f.m.status("chat")).recovery, before.recovery);
});

test("uncertain compact failure blocks instead of replaying; diagnostics are bounded/redacted; handover admission reconciles", async t => {
  const f = await fixture(t, false); let compacts = 0;
  const key = "compact";
  const session = { ...f.old, compact: async () => {
    compacts++;
    throw new TypeError("Bearer secret-token prompt: private-request " + "x".repeat(10000), { cause: Object.assign(new Error("/private/path secret-cause"), { code: "EIO" }) });
  } } as unknown as RuntimeSession;
  await f.m.prepareContinuation(key, session, async () => f.next, "compact", "intent", "resume");
  const failed = await f.m.status(key);
  assert.equal(failed.recovery!.failedAttempts, 1);
  assert.equal((await f.m.recoveryStatus(key))?.reason, "uncertain");
  assert.equal(failed.recovery!.diagnostic?.name, "TypeError");
  assert.equal(failed.recovery!.diagnostic?.causeCode, "EIO");
  assert.match(failed.recovery!.diagnostic!.fingerprint, /^[a-f0-9]{64}$/);
  const safe = JSON.stringify({ recovery: failed.recovery, failure: failed.failure, lastError: failed.lastError });
  assert.ok(safe.length < 1500);
  for (const secret of ["secret-token", "private-request", "secret-cause", "/private/path"]) assert.ok(!safe.includes(secret));
  f.advance(86400000);
  const restarted = f.create();
  for (let i = 0; i < 5; i++) {
    await restarted.prepareContinuation(key, session, async () => f.next, "compact", "intent", "resume");
    await restarted.beforeTurn(key, session, async () => f.next);
    await restarted.boundary(key, session, async () => f.next);
  }
  assert.equal(compacts, 1);
  await assert.rejects(restarted.admit(key, "blind-replay", { action: "compact", preserve: "intent", resume: "resume" }), /reconciliation/);
  await restarted.admit(key, "reconcile", { action: "handover", preserve: "intent", resume: "resume" });
  await restarted.beforeTurn(key, session, async () => f.next);
  const recovered = await restarted.status(key);
  assert.equal(recovered.recovery!.id, failed.recovery!.id);
  assert.equal(recovered.recovery!.state, "applied");
  assert.equal(compacts, 1);
});

test("legacy exhausted retries retain genuine holds when automatic handover is disabled", async t => {
  const f = await fixture(t, false);
  const file = path.join(f.home, "context-maintenance", `${createHash("sha256").update("legacy").digest("hex")}.json`);
  const legacy = { version: 1, turns: 5, lastMaintenance: 4, pending: f.request, continuationPreparationRequired: true,
    recoveryRetry: { attempts: 7, notBefore: 1794420069565 }, failure: { stage: "compact", code: "failed", phase: "after", turn: 4, action: "compact" } };
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(legacy));
  const first = await f.m.status("legacy");
  assert.equal(first.recovery!.failedAttempts, 7); assert.equal(first.recovery!.notBefore, legacy.recoveryRetry.notBefore);
  assert.equal((await f.create().recoveryStatus("legacy"))?.state, "blocked");
  assert.equal((await f.create().status("legacy")).recovery!.id, first.recovery!.id);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).pending, f.request);
  first.recovery!.inFlight = true; first.recovery!.state = "ready"; await writeFile(file, JSON.stringify(first));
  assert.equal((await f.create().recoveryStatus("legacy"))?.reason, "uncertain");
  assert.equal((await f.create().status("legacy")).recovery!.failedAttempts, 7, "uncertain reservation is not an observed failure");
});

test("mandatory cancellation retains fence/intent without incrementing failures; unstarted admission can cancel", async t => {
  const f = await fixture(t);
  await f.m.admit("cancel-unstarted", "cancel", f.request);
  await f.m.cancelAdmission("cancel-unstarted", "cancel", 1);
  assert.equal((await f.m.admissionStatus("cancel-unstarted")).execution, "cancelled");
  const session = { ...f.old, compact: async () => { throw new MaintenanceError("compact", "cancelled"); } } as unknown as RuntimeSession;
  await f.m.prepareContinuation("cancel-started", session, async () => f.next, "compact", "intent", "resume");
  const state = await f.m.status("cancel-started");
  assert.equal(state.recovery!.failedAttempts, 0);
  assert.equal(state.continuationPreparationRequired, true);
  assert.equal(state.pending?.preserve, "intent");
  assert.equal((await f.m.recoveryStatus("cancel-started"))?.state, "blocked");
});

for (const terminal of [false, true]) test(`host scheduler preserves inbox/task and runs no working prompt during ${terminal ? "terminal" : "backoff"}, even on ticks/arrivals`, async t => {
  const f = await fixture(t);
  if (terminal) for (let i = 1; i < MAX_RECOVERY_FAILURES; i++) { await f.due(f.m); await f.m.guidance("chat", f.next); }
  const before = await f.m.status("chat");
  const runtime = new FakeRuntime(); const logs: string[] = []; let assessments = 0;
  const h = new Harness({ runtime, contextMaintenance: f.create(), tickMs: 60000, log: text => { logs.push(text); },
    completionCheck: async () => { assessments++; return { state: "continue", next: "must not schedule" }; } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  const task = { id: "existing-task", original: "original operator mandate", state: "active" as const, next: "retained next step", depth: 4, recoveryEnrollment: "current" as const };
  h.state("chat").tasks = [structuredClone(task)];
  await h.recoverTasks(); await h.tick(); await h.waitForSessionIdle("chat");
  assert.equal(assessments, 0, "a held maintenance operation must fence task recovery inference too");
  assert.deepEqual(h.state("chat").tasks, [task]);
  t.after(() => h.stop(0));
  for (let i = 0; i < 4; i++) {
    await h.accept({ ...msg("next authorized request"), sessionKey: "chat", id: `arrival-${i}` });
    await h.waitForSessionIdle("chat");
    await h.tick(); await h.waitForSessionIdle("chat");
  }
  assert.equal(h.pendingInputs().filter(input => input.sessionKey === "chat").length, 4);
  assert.equal(runtime.sessions.get("chat")?.prompts.length ?? 0, 0);
  assert.equal(logs.filter(line => /turn failed/.test(line)).length, 0);
  assert.equal(assessments, 0);
  assert.deepEqual(h.state("chat").tasks, [task]);
  assert.deepEqual((await f.m.status("chat")).recovery, before.recovery);
});

test("retained host prerequisite uses its durable operation receipt after explicit recovery, not another compact", async t => {
  const f = await fixture(t, false); let compacts = 0, work = 0, checks = 0;
  const runtime = new FakeRuntime(() => { work++; return "verified"; });
  const open = runtime.open.bind(runtime);
  runtime.open = async (key, options) => {
    const session = await open(key, options);
    session.status = () => ({ sessionId: options?.fresh ? "new" : "old", contextPercent: 20 });
    session.compact = async () => { compacts++; throw Error("uncertain after possible checkpoint"); };
    session.summarize = async () => "CURRENT STATE AND NEXT STEPS: verify approved task";
    session.archiveEntries = () => [];
    session.seedHandover = async () => {};
    return session;
  };
  const m = f.create(); const h = new Harness({ runtime, contextMaintenance: m, tickMs: 60000,
    completionCheck: async () => { checks++; return { state: "completed" }; } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  t.after(() => h.stop(0));
  await h.submit({ ...msg("approved task"), id: "retained", contextPreparation: "compact" });
  await h.waitForSessionIdle("mem:room1");
  const pending = h.pendingInputs();
  assert.equal(pending.length, 1); assert.ok(pending[0].contextPreparationOperationId);
  const tasks = structuredClone(h.snapshotSessions());
  const failed = await m.status("mem:room1");
  assert.equal(failed.recovery!.id, pending[0].contextPreparationOperationId);
  for (let i = 0; i < 3; i++) { await h.tick(); await h.recoverTasks(); await h.waitForSessionIdle("mem:room1"); }
  assert.equal(compacts, 1); assert.equal(work, 0); assert.equal(checks, 0);
  assert.deepEqual(h.snapshotSessions(), tasks, "blocked maintenance cannot consume/reset a task's continuation budget");
  await m.admit("mem:room1", "reconcile", { action: "handover", preserve: "approved task", resume: "verify" });
  // Another owner instance sees the same operation and retained inbox receipt.
  const restarted = f.create();
  const old = runtime.sessions.get("mem:room1")!;
  await restarted.beforeTurn("mem:room1", old, async handover => {
    const next = await runtime.open("mem:room1", { fresh: true }); await next.seedHandover!(handover!.text); return next;
  });
  assert.equal((await restarted.status("mem:room1")).recovery!.id, failed.recovery!.id);
  await h.tick(); await h.drained();
  assert.equal(compacts, 1, "the queued compact prerequisite is satisfied by this operation's recovery");
  assert.equal(work, 1);
  assert.equal(h.pendingInputs().length, 0);
});
