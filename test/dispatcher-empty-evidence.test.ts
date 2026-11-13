import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyValidatorRegistry } from "./completion-selected.js";
import { sequentialStrategy } from "../src/dispatcher-sequential.js";
import { Harness } from "../src/harness.js";
import type { DispatchContext } from "../src/dispatcher.js";
import type { Execution, ExecutionStore } from "../src/execution.js";

/** No provider, filesystem ledger or external effects: reproduce the retained claim boundary. */
function fixture(options: { assessment?: boolean; seedFailure?: boolean; bareIntent?: boolean } = {}) {
  const report = "retained report\nSTEP-STATUS: blocked: inspect actual effects";
  const state = {
    v: 1, planner: { requested: {} },
    plan: Array.from({ length: 3 }, () => ({ task: "verify actual state", role: "simple", reason: "bounded", evidence: "verified state" })),
    outcomes: [{ role: "simple", result: "already completed A" }, { role: "simple", result: "already completed B" }],
    ...(!options.bareIntent ? { correction: { index: 2, rounds: 9, note: "Reconcile actual effects; never replay them." } } : {}),
    ...(options.assessment ? { assessment: { index: 2, reply: report, tools: 1, evidence: [], attempts: 0 } } : {}),
    progress: { index: 2, stalls: 2, receipts: [] },
  };
  const task = {
    id: "synthetic-owner", parent: "synthetic-parent", token: "new-claim", status: "running", input: "original authorized mandate",
    intent: { key: "step:synthetic-owner:2:simple", replay: "unsafe", route: { model: "p/cheap", thinking: "off" } },
    settledEffect: { key: "step:synthetic-owner:2:simple", result: "" },
    recoverySession: "dispatch:synthetic-owner:empty-old-claim", checkpoint: JSON.stringify(state),
  } as Execution;
  const calls = { workers: [] as string[], handovers: [] as string[], source: task.recoverySession, verdicts: 0 };
  const runtime = {
    modelPreflight: async () => ({ available: true, thinkingSupported: true }),
    open: async () => ({
      prompt: async () => JSON.stringify(++calls.verdicts === 1 && options.assessment
        ? { state: "continue", next: "Reconcile actual effects; do not replay." } : { state: "completed" }),
      dispose: async () => {}, abort: async () => {},
    }),
  };
  const harness = {
    runtime, state: () => ({ queue: [] }),
    sessionFor: async () => ({ status: () => ({ sessionId: "retained-source", busy: false }), archiveEntries: () => [], seedHandover: async (text: string) => {
      if (options.seedFailure) throw Error("handover persistence failed");
      calls.handovers.push(text);
    } }),
    reconcileSession(...args: Parameters<Harness["reconcileSession"]>) {
      return Harness.prototype.reconcileSession.apply(this as unknown as Harness, args);
    },
  } as unknown as Harness;
  const strategy = sequentialStrategy({
    validators: legacyValidatorRegistry(),
    harness, store: { list: () => [task] } as unknown as ExecutionStore,
    roles: () => ({ config: { enabled: true, roles: { simple: { model: "p/cheap", thinking: "off" }, validator: { model: "p/check", thinking: "off" } } }, defaults: {} }),
    resetTurn: () => {}, turn: () => ({ tools: 1, evidence: [{ name: "read", result: "synthetic verified receipt" }] }),
    runTurn: async (_context, _key, _id, text) => {
      assert.equal(calls.handovers.length, 1, "evidence must be durable before the worker starts");
      assert.ok(text.includes("original authorized mandate") || text.includes("CONTINUE STEP"));
      calls.workers.push(text); return "verified actual state\nSTEP-STATUS: complete";
    },
  });
  const context = {
    signal: new AbortController().signal,
    decisions: async () => [{ requestId: "applied-steering", text: "Finish the original mandate", state: "applied" }],
    fenceDecisions: async () => {},
    checkpoint: async (text: string) => { task.checkpoint = text; },
    workerSession: async (key: string) => { task.recoverySession = key; },
    intent: async () => {}, getSettledIntent: () => options.assessment ? report : undefined,
    settleIntent: async (_key: string, _reply: string, checkpoint: string) => { task.checkpoint = checkpoint; delete task.intent; },
    status: async () => {},
  } as unknown as DispatchContext;
  return { task, strategy, context, harness, calls };
}

test("stranded correction with applied decision and metadata-only recovery session resumes reconciliation, not completed steps", async () => {
  const env = fixture();
  const result = await env.strategy.execute(env.task, env.context);
  assert.match(result, /abgeschlossen/);
  assert.equal(env.calls.workers.length, 1);
  const evidence = env.calls.handovers[0]!;
  assert.match(evidence, /unknown/i);
  assert.match(evidence, /synthetic-owner/);
  assert.match(evidence, /already completed A/);
  assert.match(evidence, /already completed B/);
  assert.match(evidence, /Reconcile actual effects/);
  assert.equal(env.task.id, "synthetic-owner");
});

test("failed handover persistence cannot erase the retained assessment or replace its source", async () => {
  const env = fixture({ assessment: true, seedFailure: true });
  await assert.rejects(env.strategy.execute(env.task, env.context), /handover persistence failed/);
  assert.ok(JSON.parse(env.task.checkpoint!).assessment, "retain assessment until evidence transfer commits");
  assert.equal(env.task.recoverySession, env.calls.source);
  assert.equal(env.calls.workers.length, 0);
});

test("retained assessment correction receives checkpoint evidence before its worker starts", async () => {
  const env = fixture({ assessment: true });
  await env.strategy.execute(env.task, env.context);
  assert.equal(env.calls.workers.length, 1);
  assert.match(env.calls.handovers[0]!, /retained report/);
});

test("empty evidence without a retained correction or assessment stays fail-closed", async () => {
  const env = fixture({ bareIntent: true });
  await assert.rejects(env.strategy.execute(env.task, env.context), /Retained execution evidence is empty/);
  assert.equal(env.calls.workers.length, 0);
  assert.equal(env.calls.handovers.length, 0);
});

test("checkpoint handover cannot cross execution ownership", async () => {
  const env = fixture();
  await assert.rejects(env.harness.reconcileSession("dispatch:another-owner:old", "dispatch:synthetic-owner:new", {
    executionId: env.task.id, intentKey: env.task.intent!.key, checkpoint: env.task.checkpoint!,
  }), /Invalid retained execution checkpoint binding/);
  assert.equal(env.calls.handovers.length, 0);
});

test("failure after durable handover but before correction checkpoint retains assessment for a replacement claim", async () => {
  const env = fixture({ assessment: true });
  const checkpoint = env.context.checkpoint;
  env.context.checkpoint = async text => {
    if (!JSON.parse(text).assessment) throw Error("interrupted before correction checkpoint");
    await checkpoint(text);
  };
  await assert.rejects(env.strategy.execute(env.task, env.context), /interrupted before correction checkpoint/);
  assert.ok(JSON.parse(env.task.checkpoint!).assessment);
  assert.equal(env.task.recoverySession, "dispatch:synthetic-owner:new-claim");
  assert.equal(env.calls.handovers.length, 1);
  assert.equal(env.calls.workers.length, 0);
  // Simulate the replacement claim from the same durable checkpoint, not retry.
  env.context.checkpoint = checkpoint;
  env.task.token = "replacement-claim";
  env.calls.handovers.length = 0;
  env.calls.verdicts = 0;
  await env.strategy.execute(env.task, env.context);
  assert.equal(env.calls.workers.length, 1);
  assert.equal(env.calls.handovers.length, 1);
});
