import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore, ExecutionDecisionConflict } from "../src/execution.js";
import { archiveCompletedPrefix } from "../src/rolling-plan.js";
import type { SequentialState } from "../src/dispatcher-sequential.js";
import type { DispatchContext } from "../src/dispatcher.js";

async function setup(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rolling-plan-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json"), store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "original", "Original authority; preserve no activation, deadline, owner and uncertain effects", "sequential");
  const claim = await store.claim(task.id), token = claim.token!;
  const state: SequentialState = { v: 1, planner: { requested: { model: "p/planner" } },
    plan: Array.from({ length: 6 }, (_, i) => ({ task: `original step ${i}`, role: "simple", reason: "explicit original slice", evidence: `receipt ${i}` })),
    stepIds: [0, 1, 3, 4, 5, 2],
    outcomes: Array.from({ length: 5 }, (_, i) => ({ role: "simple", requested: { model: "p/exact" }, result: `already completed effect ${i}; never repeat` })),
    assessment: { index: 5, reply: "Unfinished live verification, effects unknown", tools: 37, evidence: [], attempts: 14, nextAt: Date.now() + 60000,
      route: { model: "p/old-route", thinking: "low" }, session: `dispatch:${task.id}:old-token`, decisionRevision: 0 },
    correction: { index: 5, rounds: 77, note: "Preserve retained constraints and unknown effects" }, progress: { index: 5, stalls: 31, receipts: [] },
    prior: { index: 5, result: "original settled result" },
  };
  await store.checkpoint(task.id, token, JSON.stringify(state));
  await store.intent(task.id, token, `step:${task.id}:2:simple`, "unsafe", { model: "p/old-route", thinking: "low" }, 0);
  const context: Pick<DispatchContext, "archiveCompletedPlan" | "checkpoint"> = {
    archiveCompletedPlan: (segment, revision) => store.archiveCompletedPlan(task.id, token, segment, revision),
    checkpoint: (value, notice, revision) => store.checkpoint(task.id, token, value, notice, revision),
  };
  return { file, store, task, token, state, context: context as DispatchContext };
}

test("six-slot legacy plan archives exactly five completed receipts without resetting live budgets or intent", async t => {
  const f = await setup(t), before = f.store.list()[0]!;
  const next = await archiveCompletedPrefix(f.state, f.context, 0);
  assert.equal(next.plan.length, 1); assert.equal(next.outcomes.length, 0); assert.deepEqual(next.stepIds, [2]); assert.equal(next.nextStepId, 6);
  assert.deepEqual(next.assessment, { ...f.state.assessment!, index: 0 });
  assert.deepEqual(next.correction, { ...f.state.correction!, index: 0 });
  assert.deepEqual(next.progress, { ...f.state.progress!, index: 0 });
  const after = f.store.list()[0]!; assert.deepEqual(after.intent, before.intent); assert.equal(after.token, before.token); assert.equal(after.input, before.input);
  const archived = await f.store.readPlanHistory("parent", f.task.id, next.planHistory!.head);
  assert.equal(archived.reference.completed, 5); assert.equal(archived.reference.segments, 1);
  assert.deepEqual(archived.steps.map(s => s.stepId), [0, 1, 3, 4, 5]);
  assert.deepEqual(archived.steps.map(s => s.outcome), f.state.outcomes);
  await assert.rejects(f.store.readPlanHistory("foreign", f.task.id, next.planHistory!.head), /ENOENT|binding/);
  await f.store.settleIntent(f.task.id, f.token, before.intent!.key, "synthetic retained result; no external effects", JSON.stringify(next), 0);
  await f.store.control(f.task.id, "cancel"); for (const event of f.store.events()) await f.store.ack(event.id);
  assert.equal(await f.store.compact("parent", 0), 1);
  assert.equal((await f.store.readPlanHistory("parent", f.task.id, next.planHistory!.head)).steps.length, 5, "exact completed history survives terminal ledger compaction");
});

test("archive-before-pointer crash retries exact immutable segment without dropping active work", async t => {
  const f = await setup(t); let head = "";
  const context: DispatchContext = { ...f.context, archiveCompletedPlan: async (...args) => { const ref = await f.context.archiveCompletedPlan!(...args); head = ref.head; return ref; }, checkpoint: async () => { throw Error("simulated pointer save interruption"); } };
  await assert.rejects(archiveCompletedPrefix(f.state, context, 0), /pointer save interruption/);
  const retained = JSON.parse(f.store.list()[0]!.checkpoint!); assert.equal(retained.plan.length, 6); assert.equal(retained.outcomes.length, 5); assert.equal(retained.planHistory, undefined);
  const next = await archiveCompletedPrefix(f.state, f.context, 0); assert.equal(next.planHistory!.head, head);
  const restored = new ExecutionStore(f.file); await restored.load(); assert.deepEqual(JSON.parse(restored.list()[0]!.checkpoint!), next);
});

test("parent amendment during archival fences the pointer and preserves original active window", async t => {
  const f = await setup(t);
  const context: DispatchContext = { ...f.context, archiveCompletedPlan: async (...args) => { const ref = await f.context.archiveCompletedPlan!(...args); await f.store.recordDecision("parent", f.task.id, "new-restriction", "Original scope narrowed; no new effects"); return ref; } };
  await assert.rejects(archiveCompletedPrefix(f.state, context, 0), ExecutionDecisionConflict);
  assert.equal(JSON.parse(f.store.list()[0]!.checkpoint!).planHistory, undefined);
  assert.ok(f.store.list()[0]!.intent);
});

test("history mismatch or fabricated completion cannot create an archival replay grant", async t => {
  const f = await setup(t);
  await assert.rejects(f.store.archiveCompletedPlan(f.task.id, f.token, { steps: [{ stepId: 2, step: f.state.plan[5]!, outcome: f.state.outcomes[0]! }], followUps: [] }, 0), /retained checkpoint/);
  const next = await archiveCompletedPrefix(f.state, f.context, 0);
  const reference = f.store.planHistoryReference("parent", f.task.id, next.planHistory!);
  const original = await readFile(reference.file, "utf8"); await writeFile(reference.file, original.replace("already completed effect", "fabricated completion"));
  await assert.rejects(f.store.readPlanHistory("parent", f.task.id, next.planHistory!.head), /content mismatch/);
});
