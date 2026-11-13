import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExecutionStore, executionRecoveryHash } from "../src/execution.js";
import { Dispatcher, type DispatcherStrategy } from "../src/dispatcher.js";
import { dispatchRecoveryPlugin } from "../src/dispatch-recovery-plugin.js";
import type { PluginAPI, PluginTool } from "../src/plugins.js";
import type { ArchiveEntry } from "../src/session-archive.js";

async function fixture(t: { after(fn: () => unknown): void }, policy?: { name: string; evaluate(): string }, stoppedFixture?: (task: Record<string, unknown>) => void) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "parent-recovery-"));
  const file = path.join(dir, "executions.json"); let store = new ExecutionStore(file); await store.load();
  const initial = await store.submit("parent", "original", "Continue original authorized task without repeating completed effect", "direct");
  const claimed = await store.claim(initial.id);
  await writeFile(path.join(dir, "original-effect"), "already committed", { flag: "wx" });
  await store.intent(initial.id, claimed.token!, "original-worker", "unsafe");
  await store.workerSession(initial.id, claimed.token!, `dispatch:${initial.id}:${claimed.token}`);
  await store.fail(initial.id, claimed.token!, "runtime-failure");
  if (stoppedFixture) {
    // Isolated stopped fixture only, before any Dispatcher owner is created.
    const raw = JSON.parse(await readFile(file, "utf8")); stoppedFixture(raw.executions[0]);
    await writeFile(file, JSON.stringify(raw)); store = new ExecutionStore(file); await store.load();
  }
  let runs = 0, readCalls = 0;
  const strategy: DispatcherStrategy = { name: "direct", version: 1, replaySafe: false, reconcile: true, async execute(task, context) {
    runs++; assert.equal(task.intent?.key, "original-worker"); assert.equal(task.claimedRecoveryAction, undefined);
    assert.equal(task.recoverySession, `dispatch:${initial.id}:${claimed.token}`);
    assert.equal(await readFile(path.join(dir, "original-effect"), "utf8"), "already committed");
    await writeFile(path.join(dir, "remaining-work"), "continued", { flag: "wx" });
    await context.settleIntent("original-worker", "continued without replay", "retained final checkpoint");
    return "done";
  } };
  const dispatcher = new Dispatcher(store, strategy, 1, async () => {}, () => {}, undefined, policy);
  t.after(async () => { await dispatcher.stop(); await rm(dir, { recursive: true, force: true }); });
  let entries: ArchiveEntry[] = [
    { id: "call", role: "assistant", text: JSON.stringify({ type: "toolCall", id: "tool1", name: "write", arguments: { path: "original-effect" } }) },
    { id: "result", role: "toolResult", text: JSON.stringify({ type: "toolResult", toolCallId: "tool1", toolName: "write", text: "committed" }) },
  ];
  let incomplete = false, duringRead: (() => Promise<void>) | undefined;
  let tool!: PluginTool;
  await dispatchRecoveryPlugin(() => dispatcher, async key => { readCalls++; assert.equal(key, `dispatch:${initial.id}:${claimed.token}`); await duringRead?.(); return { sessionId: "original-session", entries, incomplete }; })
    .activate({ registerTool: value => { tool = value; } } as PluginAPI);
  const run = (input: Record<string, unknown>, parent = "parent") => tool.execute({ id: initial.id, ...input }, { sessionKey: parent });
  const inspect = async () => JSON.parse(await run({ action: "evidence" }));
  const resume = (fingerprint: string, extra: Record<string, unknown> = {}) => run({ action: "continue", fingerprint, requestId: "reconciled-1", evidence: "Original local file exists unchanged, no commit/push/enrollment; all tool calls answered. Continue remaining work only.", ...extra });
  return { dir, file, store, dispatcher, initial, strategy, run, inspect, resume, runs: () => runs, readCalls: () => readCalls,
    entries: (value: ArchiveEntry[]) => { entries = value; }, incomplete: () => { incomplete = true; }, duringRead: (fn: () => Promise<void>) => { duringRead = fn; } };
}

test("parent reads retained evidence and continues SAME blocked execution without resolving through owner or replaying original effect", async t => {
  const f = await fixture(t);
  await assert.rejects(f.dispatcher.control("parent", f.initial.id, "resume"), /cannot resume/);
  const evidence = await f.inspect(); assert.equal(evidence.continuationEvidenceComplete, true);
  const before = await readFile(f.file, "utf8");
  const transcript = JSON.parse(await f.run({ action: "evidence", field: "transcript" }));
  assert.match(transcript.text, /toolCall/); assert.equal(transcript.nextEntry, 1);
  assert.equal(await readFile(f.file, "utf8"), before, "evidence inspection never edits ledger or starts a worker");
  await f.resume(evidence.fingerprint);
  let task = f.store.list()[0]!; assert.equal(task.id, f.initial.id); assert.equal(task.status, "ready");
  assert.equal(task.recoveryGrant, undefined); assert.ok(task.intent); assert.equal(task.restarts, 0);
  assert.equal(JSON.parse(await f.resume(evidence.fingerprint)).replayed, true);
  await assert.rejects(f.resume(evidence.fingerprint, { evidence: "different" }), /conflict/);
  await f.dispatcher.start();
  for (let i = 0; i < 100 && f.store.list()[0]!.status !== "completed"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  task = f.store.list()[0]!; assert.equal(task.status, "completed"); assert.equal(f.runs(), 1); assert.equal(f.store.list().length, 1);
  assert.equal(await readFile(path.join(f.dir, "original-effect"), "utf8"), "already committed");
  const reopened = new ExecutionStore(f.file); await reopened.load(); assert.equal(reopened.list()[0]!.parentContinuation?.requestId, "reconciled-1");
});

for (const variant of ["missing-result", "truncated", "incomplete", "malformed-result", "compacted"] as const) test(`uncertain ${variant} evidence cannot grant continuation`, async t => {
  const f = await fixture(t);
  if (variant === "missing-result") f.entries([{ id: "call", role: "assistant", text: '{"type":"toolCall","id":"unanswered"}' }]);
  if (variant === "truncated") f.entries([{ id: "x", role: "user", text: "partial", truncated: true }]);
  if (variant === "incomplete") f.incomplete();
  if (variant === "malformed-result") f.entries([{ id: "x", role: "toolResult", text: "not a structured result" }]);
  if (variant === "compacted") f.entries([{ id: "x", role: "compaction", text: "all done (untrusted summary)" }]);
  const evidence = await f.inspect(); assert.equal(evidence.continuationEvidenceComplete, false);
  await assert.rejects(f.resume(evidence.fingerprint)); assert.equal(f.store.list()[0]!.status, "blocked"); assert.equal(f.runs(), 0);
});

for (const variant of ["manual-pause", "cancel", "parent-stop", "expired", "ownership", "held-legacy", "question", "no-reconcile", "wrong-version", "wrong-session", "missing-session"] as const) test(`parent continuation preserves ${variant}`, async t => {
  const f = await fixture(t, undefined, task => {
    if (variant === "expired") task.dependency = { taskId: "original", original: "task", depth: 0, expiresAt: 1 };
    if (variant === "ownership") task.ownershipHold = "unscoped-parent-stop";
    if (variant === "held-legacy") task.recoveryEnrollment = "held-legacy";
    if (variant === "question") task.question = { id: "q", text: "Operator approval required" };
    if (variant === "wrong-session") task.recoverySession = "dispatch:foreign:session";
    if (variant === "missing-session") delete task.recoverySession;
  });
  if (variant === "manual-pause") await f.store.control(f.initial.id, "pause");
  else if (variant === "cancel") await f.store.control(f.initial.id, "cancel");
  else if (variant === "parent-stop") await f.store.cancelParent("parent");
  else if (variant === "no-reconcile") f.strategy.reconcile = false;
  else if (variant === "wrong-version") f.strategy.version = 2;
  await assert.rejects((async () => { const evidence = await f.inspect(); await f.resume(evidence.fingerprint); })());
  assert.equal(f.runs(), 0); assert.equal(f.store.list()[0]!.recoveryGrant, undefined);
});

test("parent cannot bypass custom recovery policy or read another conversation's transcript", async t => {
  const f = await fixture(t, { name: "host-policy", evaluate: () => "Real required approval" });
  for (const parent of ["foreign", `dispatch:${f.initial.id}:worker`, "subagent:other"]) await assert.rejects(f.run({ action: "evidence" }, parent));
  assert.equal(f.readCalls(), 0);
  const evidence = await f.inspect(); await assert.rejects(f.resume(evidence.fingerprint), /policy/);
  assert.equal(f.store.list()[0]!.status, "blocked");
});

test("concurrent pause invalidates evidence before any continuation", async t => {
  const f = await fixture(t); const evidence = await f.inspect();
  f.duringRead(() => f.store.control(f.initial.id, "pause"));
  await assert.rejects(f.resume(evidence.fingerprint), /changed/);
  assert.equal(f.store.list()[0]!.diagnosticCode, "manual-pause");
});

test("explicit authorized parent resume-paused reconciles an existing paused writer without automatic unpause or effect retry", async t => {
  const f = await fixture(t); await f.store.control(f.initial.id, "pause");
  const evidence = await f.inspect(); await assert.rejects(f.resume(evidence.fingerprint), /held/);
  await f.resume(evidence.fingerprint, { action: "resume-paused" });
  const task = f.store.list()[0]!;
  assert.equal(task.id, f.initial.id); assert.equal(task.status, "ready"); assert.equal(task.diagnosticCode, undefined);
  assert.equal(task.parentContinuation?.resumedManualPause, true); assert.ok(task.intent); assert.equal(task.recoveryGrant, undefined);
  assert.equal(JSON.parse(await f.resume(evidence.fingerprint, { action: "resume-paused" })).replayed, true);
  await assert.rejects(f.resume(evidence.fingerprint), /identity conflict/);
  await f.dispatcher.start();
  for (let i = 0; i < 100 && f.store.list()[0]!.status !== "completed"; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.store.list()[0]!.status, "completed"); assert.equal(f.runs(), 1);
});

test("a repeated identical pause is a new control revision and invalidates an earlier resume fingerprint", async t => {
  const f = await fixture(t); await f.store.control(f.initial.id, "pause"); const first = await f.inspect();
  await f.store.control(f.initial.id, "pause"); const second = await f.inspect();
  assert.notEqual(first.fingerprint, second.fingerprint);
  await assert.rejects(f.resume(first.fingerprint, { action: "resume-paused" }), /Fresh complete/);
  assert.equal(f.store.list()[0]!.diagnosticCode, "manual-pause");
});

test("explicit resume-paused still cannot override an operator parent stop", async t => {
  const f = await fixture(t); await f.store.control(f.initial.id, "pause"); const evidence = await f.inspect();
  await f.store.cancelParent("parent"); await assert.rejects(f.resume(evidence.fingerprint, { action: "resume-paused" }));
  assert.equal(f.runs(), 0);
});

test("atomic store fence rejects stale execution hash without dropping original intent", async t => {
  const f = await fixture(t), task = f.store.list()[0]!, hash = executionRecoveryHash(task);
  await f.store.control(task.id, "pause");
  await assert.rejects(f.store.continueReconciled("parent", task.id, "stale", hash, "actual read evidence", "a".repeat(64), () => {}), /changed/);
  assert.equal(f.store.list()[0]!.intent?.key, "original-worker");
});
