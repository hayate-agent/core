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
  assert.match(store.events().find(e => e.type === "status" && e.text.startsWith("Assessment stopped"))!.text, /prior results are retained/);
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


test("a later answered assessment question produces its own stalled notice", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "stalled-new-question-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const task = await store.submit("parent", "req", "original", "sequential");
  const first = await store.claim(task.id); await store.intent(task.id, first.token!, "effect", "unsafe");
  const checkpoint = JSON.stringify({ outcomes: [], assessment: { index: 0, reply: "report", mainClarification: true } });
  await store.checkpoint(task.id, first.token!, checkpoint);
  await store.ask(task.id, first.token!, "First question", true);
  await store.answer("parent", task.id, store.list()[0]!.question!.id, "First answer");
  const second = await store.claim(task.id, { strategy: "sequential", version: 1, replaySafe: false, reconcile: true });
  await store.fail(task.id, second.token!, "assessment-stalled");
  const old = store.events().find(e => e.type === "assessment-stalled")!; await store.ack(old.id);
  // Simulate a legitimately reconciled claim, preserving the same effect intent.
  const storage = new PartitionedJson(store.file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 });
  const data = await storage.load(); const row = (data!.executions as any[]).find(e => e.id === task.id);
  row.status = "ready"; row.recoveryGrant = { action: "continue", restarts: row.restarts };
  await storage.save(data!, true);
  const fresh = new ExecutionStore(store.file); await fresh.load();
  const third = await fresh.claim(task.id, { strategy: "sequential", version: 1, replaySafe: false, reconcile: true });
  await fresh.checkpoint(task.id, third.token!, checkpoint);
  await fresh.ask(task.id, third.token!, "Second question", true);
  assert.equal(fresh.list()[0]!.assessmentStalledEventId, undefined);
  await fresh.answer("parent", task.id, fresh.list()[0]!.question!.id, "Second answer");
  const fourth = await fresh.claim(task.id, { strategy: "sequential", version: 1, replaySafe: false, reconcile: true });
  await fresh.fail(task.id, fourth.token!, "assessment-stalled");
  const notice = fresh.events().find(e => e.type === "assessment-stalled")!;
  assert.ok(notice); assert.notEqual(notice.id, old.id);
  assert.equal(fresh.list()[0]!.intent?.key, "effect");
});

test("startup repairs a stalled receipt from an older question episode once", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "stale-stalled-")); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json"), store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "req", "original", "sequential");
  const first = await store.claim(task.id); await store.intent(task.id, first.token!, "effect", "unsafe");
  await store.checkpoint(task.id, first.token!, JSON.stringify({ outcomes: [], assessment: { index: 0, reply: "report", mainClarification: true } }));
  await store.ask(task.id, first.token!, "Current question", true); await store.answer("parent", task.id, store.list()[0]!.question!.id, "Current answer");
  const next = await store.claim(task.id, { strategy: "sequential", version: 1, replaySafe: false, reconcile: true });
  await store.fail(task.id, next.token!, "assessment-stalled");
  const storage = new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 });
  const data = await storage.load(); const row = (data!.executions as any[]).find(e => e.id === task.id);
  row.assessmentStalledEventId = "old-event"; row.assessmentStalledQuestionId = "old-question"; data!.events = [];
  await storage.save(data!, true);
  const fresh = new ExecutionStore(file); await fresh.load(); await fresh.recover(new Map()); await fresh.recover(new Map());
  const notices = fresh.events().filter(e => e.type === "assessment-stalled");
  assert.equal(notices.length, 1); assert.notEqual(notices[0]!.id, "old-event");
  assert.equal(fresh.list()[0]!.assessmentStalledQuestionId, fresh.list()[0]!.question!.id);
  assert.equal(fresh.list()[0]!.intent?.key, "effect");
});

test("startup preserves legacy unbound receipt rather than inventing a duplicate", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "legacy-receipt-")); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json"), store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "req", "original", "sequential");
  const first = await store.claim(task.id); await store.intent(task.id, first.token!, "effect", "unsafe");
  await store.checkpoint(task.id, first.token!, JSON.stringify({ outcomes: [], assessment: { index: 0, reply: "report", mainClarification: true } }));
  await store.ask(task.id, first.token!, "Question", true); await store.answer("parent", task.id, store.list()[0]!.question!.id, "Answer");
  const next = await store.claim(task.id, { strategy: "sequential", version: 1, replaySafe: false, reconcile: true });
  await store.fail(task.id, next.token!, "assessment-stalled");
  const notice = store.events().find(e => e.type === "assessment-stalled")!; await store.ack(notice.id);
  const storage = new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 });
  const data = await storage.load(); delete (data!.executions as any[]).find(e => e.id === task.id).assessmentStalledQuestionId; await storage.save(data!, true);
  const fresh = new ExecutionStore(file); await fresh.load(); await fresh.recover(new Map());
  assert.equal(fresh.events().filter(e => e.type === "assessment-stalled").length, 0);
  assert.equal(fresh.list()[0]!.assessmentStalledEventId, notice.id);
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

test("an admitted stalled-assessment turn keeps its authority after its own decision wakes the execution", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "stalled-active-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const task = await store.submit("parent", "req", "original", "sequential");
  const first = await store.claim(task.id); await store.intent(task.id, first.token!, "effect", "unsafe");
  await store.checkpoint(task.id, first.token!, JSON.stringify({ outcomes: [], assessment: { index: 0, reply: "report", mainClarification: true } }));
  await store.ask(task.id, first.token!, "What remains?", true);
  await store.answer("parent", task.id, store.list()[0]!.question!.id, "Inspect receipt");
  const next = await store.claim(task.id, { strategy: "sequential", version: 1, replaySafe: false, reconcile: true });
  await store.fail(task.id, next.token!, "assessment-stalled");
  const notice = store.events().find(e => e.type === "assessment-stalled")!;
  const input = { id: `dispatch-event:${notice.id}`, source: "host" as const, sessionKey: "parent", text: store.assessmentStalledText(store.list()[0]!), hostEvent: { executionId: task.id, assessmentStalled: { eventId: notice.id } } };
  assert.equal(store.assessmentStalledAllowed(input), true);
  // The turn's own steering decision legitimately wakes the held execution.
  await store.recordDecision("parent", task.id, "own-step", "Concrete independent next step", () => true);
  assert.equal(store.list()[0]!.status, "ready");
  assert.equal(store.assessmentStalledAllowed(input), false, "a queued or replayed notice must not be admitted from a woken execution");
  assert.equal(store.assessmentStalledAllowed(input, true), true, "the already admitted active turn keeps its authority");
  assert.equal(store.assessmentStalledAllowed({ ...input, sessionKey: "other" }, true), false);
  assert.equal(store.assessmentStalledAllowed({ ...input, text: input.text + " forged" }, true), false);
  await store.control(task.id, "pause");
  await store.control(task.id, "cancel").catch(() => undefined);
  assert.equal(store.assessmentStalledAllowed(input, true), false, "pause/cancel still revoke the active turn");
});
