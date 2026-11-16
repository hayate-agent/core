import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExecutionStore } from "../src/execution.js";
import { PartitionedJson } from "../src/partitioned-json.js";

test("startup restores a legacy acknowledged assessment question exactly once without replaying its effect", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "legacy-question-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "request", "authorized work", "sequential");
  const claim = await store.claim(task.id);
  await store.intent(task.id, claim.token!, "worker-effect", "unsafe");
  await store.checkpoint(task.id, claim.token!, JSON.stringify({ outcomes: [], assessment: { mainClarification: true, index: 0, reply: "Retained report" } }));
  await store.ask(task.id, claim.token!, "Which evidence is missing?", true);
  const event = store.events().find(e => e.type === "question")!;
  await store.ack(event.id);
  // Reproduce a pre-upgrade record: no retained event identity and no outbox event.
  // Re-save through the content-addressed store, preserving checksums.
  const storage = new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 });
  const data = await storage.load();
  const entry = (data!.executions as any[]).find(e => e.id === task.id); delete entry.question.eventId;
  await storage.save(data!, true);
  const fresh = new ExecutionStore(file); await fresh.load();
  await fresh.recover(new Map());
  const restored = fresh.events().filter(e => e.type === "question");
  assert.equal(restored.length, 1);
  assert.equal(fresh.list()[0]!.intent?.key, "worker-effect");
  assert.equal(fresh.list()[0]!.status, "paused");
  await fresh.recover(new Map());
  assert.equal(fresh.events().filter(e => e.type === "question").length, 1);
  await fresh.ack(restored[0]!.id); await fresh.recover(new Map());
  assert.equal(fresh.events().filter(e => e.type === "question").length, 0);
});

test("startup restores an acknowledged ordinary question without restarting the worker", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "legacy-ordinary-question-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "request", "authorized work", "direct");
  const claim = await store.claim(task.id); await store.ask(task.id, claim.token!, "Which target?");
  await store.ack(store.events().find(e => e.type === "question")!.id);
  const storage = new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 });
  const data = await storage.load(); delete (data!.executions as any[]).find(e => e.id === task.id).question.eventId;
  await storage.save(data!, true);
  const fresh = new ExecutionStore(file); await fresh.load(); await fresh.recover(new Map());
  assert.equal(fresh.events().filter(e => e.type === "question").length, 1);
  assert.equal(fresh.list()[0]!.status, "paused");
});

test("retained assessment question survives restart and answer never settles the effect intent", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "assessment-question-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file);
  await store.load();
  const task = await store.submit("parent", "request", "authorized work", "sequential");
  const running = await store.claim(task.id);
  await store.intent(task.id, running.token!, "worker-effect", "unsafe");
  await assert.rejects(store.ask(task.id, running.token!, "Clarify?"), /unresolved effect intent/);
  await assert.rejects(store.ask(task.id, running.token!, "Clarify?", true), /checkpoint required/);
  await store.checkpoint(task.id, running.token!, JSON.stringify({
    outcomes: [], assessment: { mainClarification: true, index: 0, reply: "Retained report" },
  }));
  await store.ask(task.id, running.token!, "Which evidence is missing?", true);
  const question = store.list()[0]!.question!;
  const fresh = new ExecutionStore(file);
  await fresh.load();
  assert.equal(fresh.list()[0]!.question?.retainedAssessment, true);
  await assert.rejects(fresh.answer("other-parent", task.id, question.id, "Override"), /awaiting/);
  await assert.rejects(fresh.answer("parent", task.id, "stale-id", "Override"), /awaiting/);
  await fresh.answer("parent", task.id, question.id, "Inspect existing evidence only");
  assert.equal(fresh.list()[0]!.intent?.key, "worker-effect");
  assert.equal(fresh.list()[0]!.intent?.replay, "unsafe");
  assert.equal(fresh.list()[0]!.settledEffect, undefined);
  await assert.rejects(fresh.answer("parent", task.id, question.id, "Again"), /awaiting/);
});


test("stalled answered assessment creates one durable task-bound notification without replay", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "stalled-notice-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "req", "original", "sequential");
  const first = await store.claim(task.id); await store.intent(task.id, first.token!, "effect", "unsafe");
  await store.checkpoint(task.id, first.token!, JSON.stringify({ outcomes: [], assessment: { index: 0, reply: "report", mainClarification: true } }));
  await store.ask(task.id, first.token!, "What remains?", true);
  await store.answer("parent", task.id, store.list()[0]!.question!.id, "Inspect receipt");
  const next = await store.claim(task.id, { strategy: "sequential", version: 1, replaySafe: false, reconcile: true });
  await store.fail(task.id, next.token!, "assessment-stalled");
  const notice = store.events().find(e => e.type === "assessment-stalled")!;
  assert.ok(notice); const held = store.list()[0]!;
  const input = { id: `dispatch-event:${notice.id}`, source: "host" as const, sessionKey: "parent", text: store.assessmentStalledText(held), hostEvent: { executionId: task.id, assessmentStalled: { eventId: notice.id } } };
  assert.equal(store.assessmentStalledAllowed(input), true);
  assert.equal(store.assessmentStalledAllowed({ ...input, sessionKey: "other" }), false);
  assert.equal(store.assessmentStalledAllowed({ ...input, text: input.text + " forged" }), false);
  await store.ack(notice.id);
  const fresh = new ExecutionStore(file); await fresh.load(); await fresh.recover(new Map());
  assert.equal(fresh.events().filter(e => e.type === "assessment-stalled").length, 0);
  assert.equal(fresh.assessmentStalledAllowed(input), true);
  assert.equal(fresh.list()[0]!.intent?.key, "effect");
  assert.equal(fresh.list()[0]!.recoveryGrant, undefined);
  await fresh.control(task.id, "pause");
  assert.equal(fresh.assessmentStalledAllowed(input), false);
});


test("startup reconstructs only eligible legacy exhausted assessment notice once", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "legacy-stalled-")); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json"); const store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "req", "original", "sequential");
  const first = await store.claim(task.id); await store.intent(task.id, first.token!, "effect", "unsafe");
  await store.checkpoint(task.id, first.token!, JSON.stringify({ outcomes: [], assessment: { index: 0, reply: "report", mainClarification: true } }));
  await store.ask(task.id, first.token!, "What remains?", true); await store.answer("parent", task.id, store.list()[0]!.question!.id, "Inspect receipt");
  const next = await store.claim(task.id, { strategy: "sequential", version: 1, replaySafe: false, reconcile: true }); await store.fail(task.id, next.token!, "assessment-stalled");
  const storage = new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 });
  const data = await storage.load(); const row = (data!.executions as any[]).find(e => e.id === task.id);
  row.diagnosticCode = "retry-exhausted"; delete row.assessmentStalledEventId;
  data!.events = (data!.events as any[]).filter(e => e.type !== "assessment-stalled"); await storage.save(data!, true);
  const fresh = new ExecutionStore(file); await fresh.load(); await fresh.recover(new Map()); await fresh.recover(new Map());
  assert.equal(fresh.events().filter(e => e.type === "assessment-stalled").length, 1);
  assert.equal(fresh.list()[0]!.diagnosticCode, "retry-exhausted"); assert.equal(fresh.list()[0]!.intent?.key, "effect");
});
