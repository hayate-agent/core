import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore, ExecutionDecisionConflict } from "../src/execution.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "decision-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ledger.json");
  const store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "task", "original scope; no activation", "sequential");
  return { store, task, file };
}

test("decision acceptance is durable, exact idempotent, bounded and parent scoped", async t => {
  const { store, task, file } = await fixture(t);
  const first = await store.recordDecision("parent", task.id, "decision-1", "accept documented temporary-file deviation");
  assert.equal(first.state, "pending");
  assert.deepEqual(await store.recordDecision("parent", task.id, "decision-1", first.text), first);
  await assert.rejects(store.recordDecision("parent", task.id, "decision-1", "different"), /Conflicting/);
  await assert.rejects(store.recordDecision("other", task.id, "decision-2", "no"), /conversation/);
  for (const parent of ["dispatch:x", "subagent:x"]) await assert.rejects(store.recordDecision(parent, task.id, "d", "no"), /Nested/);
  for (const [id, text] of [["", "text"], [" ", "text"], ["x".repeat(129), "text"], ["id", ""], ["id", " \n "], ["id", "😀".repeat(1001)]]) {
    await assert.rejects(store.recordDecision("parent", task.id, id!, text!), /Invalid/);
  }
  const reloaded = new ExecutionStore(file); await reloaded.load();
  assert.deepEqual(reloaded.list()[0]!.decisions, [first]);
  assert.deepEqual(await reloaded.recordDecision("parent", task.id, "decision-1", first.text), first);
  const claim = await reloaded.claim(task.id);
  await assert.rejects(reloaded.applyDecisions(task.id, "stale"), /claim|ownership|Stale/i);
  const applied = await reloaded.applyDecisions(task.id, claim.token!);
  assert.equal(applied[0]!.state, "applied");
  assert.match(applied[0]!.appliedClaim!, /^[a-f0-9]{64}$/);
  assert.notEqual(applied[0]!.appliedClaim, claim.token);
  const afterApply = new ExecutionStore(file); await afterApply.load();
  assert.deepEqual(afterApply.list()[0]!.decisions, applied);
  assert.deepEqual(await reloaded.recordDecision("parent", task.id, "decision-1", first.text), applied[0]);
  await reloaded.complete(task.id, claim.token!, "done", 1);
  await assert.rejects(reloaded.recordDecision("parent", task.id, "decision-1", first.text), /cannot accept/);
  for (const event of reloaded.events()) await reloaded.ack(event.id);
  assert.equal(await reloaded.compact("parent", 0), 1);
  assert.deepEqual((await reloaded.findRequest("parent", "task"))!.decisions, applied, "archived audit survives compaction");
});

test("active-worker race preserves ownership/intent and fences stale assessment commits", async t => {
  const { store, task } = await fixture(t);
  const claim = await store.claim(task.id);
  await store.intent(task.id, claim.token!, "step:0", "unsafe", { model: "p/worker" }, 0);
  await store.checkpoint(task.id, claim.token!, "settled evidence");
  const before = store.list()[0]!;
  await store.recordDecision("parent", task.id, "d", "accept deviation", () => true);
  assert.equal(store.list()[0]!.token, claim.token, "recording cannot steal claim");
  assert.deepEqual(store.list()[0]!.intent, before.intent);
  await assert.rejects(store.settleIntent(task.id, claim.token!, "step:0", "stale result", "stale checkpoint", 0), ExecutionDecisionConflict);
  assert.equal(store.list()[0]!.checkpoint, "settled evidence");
  await assert.rejects(store.deferAssessment(task.id, claim.token!, Date.now() + 60000, 0), ExecutionDecisionConflict);
  await assert.rejects(store.complete(task.id, claim.token!, "stale", 0), ExecutionDecisionConflict);
  await store.deferDecision(task.id, claim.token!);
  assert.deepEqual(store.list()[0]!.intent, before.intent, "yield never clears ambiguous intent");
  await assert.rejects(store.applyDecisions(task.id, claim.token!), /claim|ownership|Stale/i);
  await assert.rejects(store.claim(task.id), /reconcil|ambiguous|policy|strategy/i);
});

test("decision before intent is fenced and cancelled tasks never accept decisions", async t => {
  const { store, task } = await fixture(t);
  const claim = await store.claim(task.id);
  await store.recordDecision("parent", task.id, "d", "scoped context");
  await assert.rejects(store.intent(task.id, claim.token!, "effect", "unsafe", undefined, 0), ExecutionDecisionConflict);
  assert.equal(store.list()[0]!.intent, undefined);
  await store.control(task.id, "cancel");
  await assert.rejects(store.recordDecision("parent", task.id, "d", "scoped context"), /cannot accept/);
});

test("parent stop rejects decisions and cannot be reanimated", async t => {
  const { store, task } = await fixture(t);
  await store.cancelParent("parent");
  await assert.rejects(store.recordDecision("parent", task.id, "stopped", "accept deviation", () => true), /cannot accept/);
  assert.equal(store.list()[0]!.status, "cancelled");
  assert.equal(store.list()[0]!.decisions, undefined);
});

test("pending questions and manual pauses cannot be bypassed by a decision", async t => {
  const { store, task } = await fixture(t);
  const claim = await store.claim(task.id);
  await store.ask(task.id, claim.token!, "Which target?");
  await store.recordDecision("parent", task.id, "question", "accept deviation", () => true);
  assert.equal(store.list()[0]!.status, "paused");
  assert.equal(store.list()[0]!.question!.answer, undefined);
  await assert.rejects(store.control(task.id, "resume"), /cannot resume/);
  await store.answer("parent", task.id, store.list()[0]!.question!.id, "original target");
  await store.control(task.id, "pause");
  await store.recordDecision("parent", task.id, "pause", "accept deviation", () => true);
  assert.equal(store.list()[0]!.status, "paused");
  assert.equal(store.list()[0]!.diagnosticCode, "manual-pause");
});

test("explicit pause of a blocked retained assessment survives reload and decision delivery", async t => {
  const { store, task, file } = await fixture(t);
  const claim = await store.claim(task.id);
  await store.intent(task.id, claim.token!, "step:0", "unsafe", { model: "p/worker" }, 0);
  await store.checkpoint(task.id, claim.token!, "settled assessment evidence");
  await store.fail(task.id, claim.token!, "runtime-failure");
  const blocked = store.list()[0]!;
  assert.equal(blocked.status, "blocked");
  await store.control(task.id, "pause");
  const reloaded = new ExecutionStore(file); await reloaded.load();
  assert.equal(reloaded.list()[0]!.diagnosticCode, "manual-pause");
  await reloaded.recordDecision("parent", task.id, "hold", "accept documented deviation", () => true);
  const afterDecision = new ExecutionStore(file); await afterDecision.load();
  const held = afterDecision.list()[0]!;
  assert.equal(held.status, "blocked", "decision must not wake the explicit hold");
  assert.equal(held.diagnosticCode, "manual-pause");
  assert.deepEqual(held.intent, blocked.intent, "pause preserves unresolved effect evidence");
  assert.equal(held.checkpoint, blocked.checkpoint);
  assert.equal(held.decisions![0]!.state, "pending");
  await assert.rejects(afterDecision.control(task.id, "resume"), /cannot resume/);
});

test("decision validation on reload rejects corrupt audits and receipt limits fail closed", async t => {
  const { store, task, file } = await fixture(t);
  for (let i = 0; i < 32; i++) await store.recordDecision("parent", task.id, `d${i}`, "scoped context");
  await assert.rejects(store.recordDecision("parent", task.id, "d32", "extra"), /limit/);
  const large = await store.submit("parent", "large", "original", "sequential");
  for (let i = 0; i < 3; i++) await store.recordDecision("parent", large.id, `large${i}`, "x".repeat(4000));
  await assert.rejects(store.recordDecision("parent", large.id, "large3", "x".repeat(4000)), /data limit/);
  const data = JSON.parse(await readFile(file, "utf8"));
  data.executions[0].decisions[0].state = "applied"; // missing appliedClaim/At
  await writeFile(file, JSON.stringify(data));
  await assert.rejects(new ExecutionStore(file).load(), /Invalid execution decisions/);
});
