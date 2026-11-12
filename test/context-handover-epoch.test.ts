import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { RuntimeSession } from "../src/types.js";

async function homeFor(t: { after(fn: () => Promise<unknown>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "handover-epoch-"));
  t.after(() => rm(home, { recursive: true, force: true })); return home;
}

for (const summaryFails of [false, true]) test(`failed compact → independent handover → queued working turns; summary failure=${summaryFails}`, async t => {
  const home = await homeFor(t);
  let compacts = 0, summaries = 0, nativeSummaries = 0, rotations = 0, work = 0;
  const entries = [{ id: "operator", role: "user", text: "Continue the approved task; do not repeat the completed deployment" },
    { id: "effect", role: "toolResult", text: "Completed deployment, receipt 123" }];
  const m = new ContextMaintenance(home, () => contextPolicy(), undefined, Date.now, async (_instructions, source) => {
    summaries++; assert.deepEqual(source, entries);
    if (summaryFails) throw Error("provider summary unavailable");
    return "CURRENT STATE AND NEXT STEPS\nDeployment completed, receipt 123; continue only remaining authorized work.";
  });
  const runtime = new FakeRuntime(() => { work++; return "approved work verified"; });
  const open = runtime.open.bind(runtime);
  runtime.open = async (key, options) => {
    const session = await open(key, options); const fresh = !!options?.fresh;
    if (fresh) rotations++;
    session.status = () => ({ sessionId: fresh ? "fresh" : "retired", contextPercent: fresh ? 5 : 90 });
    session.compact = async () => { compacts++; throw Error("old compaction failed"); };
    session.summarize = async () => { nativeSummaries++; throw Error("must not compact source to summarize"); };
    session.archiveEntries = () => entries;
    session.seedHandover = async text => { assert.match(text, /Archive ID:/); assert.match(text, /not be replayed blindly/); };
    return session;
  };
  const h = new Harness({ runtime, contextMaintenance: m, tickMs: 60000,
    completionCheck: async () => ({ state: "completed" }) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  t.after(() => h.stop(0));
  // The original input remains durable while its compaction prerequisite fails.
  await h.submit({ ...msg("approved task"), id: "first", contextPreparation: "compact" });
  await h.waitForSessionIdle("mem:room1");
  await h.tick(); await h.drained();
  await h.submit({ ...msg("next authorized message"), id: "second" }); await h.drained();
  assert.equal(work, 2); assert.equal(h.pendingInputs().length, 0);
  assert.equal(compacts, 1); assert.equal(rotations, 1); assert.equal(summaries, 1); assert.equal(nativeSummaries, 0);
  const state = await m.status("mem:room1");
  assert.equal(state.sessionId, "fresh"); assert.equal(state.pending, undefined);
  assert.equal(state.failure, undefined); assert.equal(state.lastError, undefined);
  assert.equal(state.pressureSinceCompaction, false); assert.equal(state.handoverAfterFailure, undefined);
  assert.equal(state.recoveryRetry, undefined); assert.equal(state.continuationPreparationRequired, undefined);
  assert.equal(state.recovery?.state, "applied"); assert.equal(state.recovery?.reason, undefined);
  assert.equal(await m.recoveryStatus("mem:room1"), undefined);
  const archive = await m.archives.load("mem:room1", state.handover!.archiveId!);
  assert.deepEqual(archive.entries, entries); assert.equal(archive.targetSessionId, "fresh");
});

test("legacy exhausted compact migrates once, closes old pressure epoch and accepts the next turn", async t => {
  const home = await homeFor(t), key = "legacy";
  const file = path.join(home, "context-maintenance", `${createHash("sha256").update(key).digest("hex")}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, sessionId: "old", turns: 80, lastMaintenance: 76, lastCompact: 76,
    pressureSinceCompaction: true, observation: { phase: "after", usage: "known", percent: 98, decision: "compact", turn: 80 },
    assessmentFailures: { before: 7, after: 7 }, pending: { action: "compact", preserve: "original task", resume: "pending messages" },
    continuationPreparationRequired: true, recoveryRetry: { attempts: 7, notBefore: 9999999999999 },
    failure: { stage: "compact", code: "failed", phase: "after", turn: 80, action: "compact" } }));
  const m = new ContextMaintenance(home, () => contextPolicy());
  const migrated = await m.status(key), id = migrated.recovery!.id;
  assert.equal(migrated.recovery!.failedAttempts, 7); assert.equal(migrated.pending?.action, "handover");
  assert.equal(await m.recoveryStatus(key), undefined);
  let nativeSummaries = 0, compacts = 0;
  const old = { status: () => ({ sessionId: "old", contextPercent: 98 }), archiveEntries: () => [],
    summarize: async () => { nativeSummaries++; throw Error("same broken native compaction"); } } as unknown as RuntimeSession;
  const next = { status: () => ({ sessionId: "new", contextPercent: 5 }), compact: async () => { compacts++; } } as unknown as RuntimeSession;
  await m.beforeTurn(key, old, async () => next);
  const fresh = await m.status(key);
  assert.equal(fresh.turns, 0); assert.equal(fresh.lastMaintenance, 0); assert.equal(fresh.lastCompact, undefined);
  assert.equal(fresh.assessmentFailures, undefined); assert.equal(fresh.beforeObservation, undefined);
  assert.equal(fresh.recovery!.id, id); assert.equal(fresh.recovery!.state, "applied");
  assert.equal(nativeSummaries, 0);
  const restarted = new ContextMaintenance(home, () => contextPolicy());
  await restarted.beforeTurn(key, next, async () => { throw Error("must not rotate again"); });
  await restarted.boundary(key, next, async () => { throw Error("must not rotate again"); });
  assert.equal(compacts, 0); assert.equal((await restarted.status(key)).pending, undefined);
});

test("stalled independent summary times out into an archive-backed fresh session", async t => {
  const home = await homeFor(t); let started!: () => void, signal!: AbortSignal;
  const ready = new Promise<void>(resolve => { started = resolve; });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = new ContextMaintenance(home, () => contextPolicy(), undefined, Date.now, async (_instructions, _entries, _model, abort) => {
    signal = abort; started(); return new Promise<string>(() => {});
  });
  const old = { status: () => ({ sessionId: "old" }), archiveEntries: () => [] } as unknown as RuntimeSession;
  await m.request("chat", { action: "handover", preserve: "approved task", resume: "remaining work" });
  const result = m.beforeTurn("chat", old, async () => ({ status: () => ({ sessionId: "fresh" }) }) as RuntimeSession);
  await ready; t.mock.timers.tick(30000); await result;
  assert.equal(signal.aborted, true); assert.equal((await m.status("chat")).sessionId, "fresh");
  assert.equal(await m.recoveryStatus("chat"), undefined);
});

test("interrupting a read-only handover summary waits briefly, never installs an uncertainty hold", async t => {
  const home = await homeFor(t); let now = 1000, started!: () => void, attempts = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const m = new ContextMaintenance(home, () => contextPolicy(), undefined, () => now, async (_instructions, _entries, _model, signal) => {
    if (++attempts > 1) return "CURRENT STATE AND NEXT STEPS: verify remaining authorized work";
    started(); return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }));
  });
  const old = { status: () => ({ sessionId: "old" }), archiveEntries: () => [] } as unknown as RuntimeSession;
  const rotate = async () => ({ status: () => ({ sessionId: "fresh" }) }) as RuntimeSession;
  const result = m.prepareContinuation("chat", old, rotate, "handover", "approved task", "remaining work");
  await ready; m.interrupt("chat"); await result;
  const waiting = await m.status("chat");
  assert.equal(waiting.recovery!.state, "waiting"); assert.equal(waiting.recovery!.reason, "backoff");
  assert.equal(waiting.recovery!.failedAttempts, 0);
  now = waiting.recovery!.notBefore!;
  await m.beforeTurn("chat", old, rotate);
  assert.equal((await m.status("chat")).recovery!.state, "applied");
});

test("prepared refresh uses independent summary even without a native summarize method", async t => {
  const home = await homeFor(t); let summaries = 0;
  const entries = [{ id: "first", role: "user", text: "approved task" }];
  const m = new ContextMaintenance(home, () => contextPolicy(), undefined, Date.now, async () => {
    summaries++; return "CURRENT STATE AND NEXT STEPS: preserve corrections and verify remaining work";
  });
  const old = { status: () => ({ sessionId: "old" }), archiveEntries: () => entries } as unknown as RuntimeSession;
  await m.request("chat", { action: "handover", preserve: "approved task", resume: "remaining work" });
  await m.beforeTurn("chat", old, async () => { throw Error("rotation failed"); });
  entries.push({ id: "correction", role: "user", text: "do not deploy" });
  await m.admit("chat", "reconcile", { action: "handover", preserve: "approved task", resume: "remaining work" });
  await m.beforeTurn("chat", old, async () => ({ status: () => ({ sessionId: "fresh" }) }) as RuntimeSession);
  assert.equal(summaries, 2); assert.equal((await m.status("chat")).sessionId, "fresh");
  assert.equal(await m.recoveryStatus("chat"), undefined);
});

test("an independent summary ignoring abort cannot delay stop or rotate on a late result", async t => {
  const home = await homeFor(t); let started!: () => void, settle!: (text: string) => void, rotations = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const m = new ContextMaintenance(home, () => contextPolicy(), undefined, Date.now, async () => {
    started(); return new Promise<string>(resolve => { settle = resolve; });
  });
  const old = { status: () => ({ sessionId: "old" }), archiveEntries: () => [] } as unknown as RuntimeSession;
  await m.request("chat", { action: "handover", preserve: "approved task", resume: "remaining work" });
  const result = m.beforeTurn("chat", old, async () => { rotations++; throw Error("not allowed"); });
  await ready; m.interrupt("chat"); await result;
  settle("CURRENT STATE AND NEXT STEPS: late summary"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(rotations, 0); assert.equal((await m.status("chat")).sessionId, "old");
});
