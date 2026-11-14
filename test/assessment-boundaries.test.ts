import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCompletion, assessmentPolicyStamp, completionTimeout } from "../src/completion-check.js";
import { ValidatorRegistry } from "../src/validator.js";
import { renderCompletionPrompt } from "../src/completion-budget.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import { sequentialStrategy } from "../src/dispatcher-sequential.js";
import type { Execution } from "../src/execution.js";

const input = () => ({ source: "host" as const, sessionKey: "mem:room1", text: "Original task" });
const prompt = (i: any, reply: string, a: any) => `DATA: ${JSON.stringify({ task: a.task, reply, context: i.completionContext })}`;

test("transport-specific budget is honored without truncating original authority or changing live evidence", async () => {
  const registry = new ValidatorRegistry(); let calls = 0, actual = "";
  registry.register({ apiVersion: 1, name: "small-transport", version: 1, requiresModel: false, maxPromptBytes: 24000,
    assess: async request => { calls++; actual = request.promptText; assert.ok(Buffer.byteLength(actual) <= 24000); return { state: "completed" }; } }); registry.select("small-transport");
  const i = { ...input(), completionContext: { recent: [], tasks: [], tools: [{ name: "read", error: false, result: "x".repeat(42000) }] } };
  const before = JSON.stringify(i), scope = "Exact original authorized scope; never deploy";
  assert.equal((await assessCompletion({ review: async () => { throw Error("No fallback"); } }, i, "settled worker result", { task: scope }, new AbortController().signal,
    undefined, Date.now, prompt, undefined, 1000, registry))?.state, "completed");
  assert.equal(calls, 1); assert.equal(JSON.parse(actual.slice(6)).task, scope); assert.equal(JSON.stringify(i), before);
  assert.equal(renderCompletionPrompt(prompt, input(), "reply", { task: "x".repeat(25000) }, Date.now, 24000), undefined);
  for (const value of [0, NaN, 56001]) assert.throws(() => new ValidatorRegistry().register({ apiVersion: 1, name: "invalid", version: 1, maxPromptBytes: value, assess: async () => ({ state: "completed" }) }));
});

test("shared model capacity wait cannot consume provider execution timeout", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void; const queued = new Promise<void>(r => { release = r; }); let calls = 0;
  const registry = new ValidatorRegistry(); registry.register({ apiVersion: 1, name: "fixture", version: 1, assess: async () => { calls++; return { state: "continue", next: "Inspect existing state only" }; } }); registry.select("fixture");
  const result = assessCompletion({ admit: async work => { await queued; return work(); }, review: async () => "unused" }, input(), "retained", { task: "Original scope" }, new AbortController().signal, undefined, Date.now, prompt, undefined, 1000, registry);
  t.mock.timers.tick(5000); await Promise.resolve(); assert.equal(calls, 0);
  release(); assert.equal((await result)?.state, "continue"); assert.equal(calls, 1);
});

test("expiry during admission cannot reach provider or authorize work", async () => {
  let now = 1, calls = 0; const registry = new ValidatorRegistry(); registry.register({ apiVersion: 1, name: "fixture", version: 1, assess: async () => { calls++; return { state: "completed" }; } }); registry.select("fixture");
  const result = await assessCompletion({ admit: async work => { now = 100; return work(); }, review: async () => "unused" }, input(), "retained", { task: "Scope", expiresAt: 50 }, new AbortController().signal, undefined, () => now, prompt, undefined, 1000, registry);
  assert.equal(result, undefined); assert.equal(calls, 0);
});

test("slow configured validators get the same bounded default as step verification; explicit limits remain exact", () => {
  assert.equal(completionTimeout(), 120000); assert.equal(completionTimeout(30000), 30000); assert.equal(completionTimeout(1000), 1000);
  const registry = new ValidatorRegistry(); registry.register({ apiVersion: 1, name: "fixture", version: 1, assess: async () => undefined }); registry.select("fixture");
  assert.notEqual(assessmentPolicyStamp(registry, {}, 30000), assessmentPolicyStamp(registry, {}, 120000));
});

test("provider policy update gives one fresh read-only parent assessment, not hour-long inherited backoff or budget reset", async () => {
  let assessments = 0, working = 0; const rt = new FakeRuntime(() => { working++; return "must not run without verdict"; });
  const h = new Harness({ runtime: rt, now: () => 1000, assessmentPolicy: () => "new-provider-contract", completionCheck: async () => { assessments++; return undefined; } });
  h.onStateChange = async () => {}; h.restoreSessions([{ key: "mem:room1", task: { id: "original", original: "Authorized retained task", recoveryEnrollment: "current", state: "active", depth: 3,
    next: "Do not replay this old proposal", recoveryAssessment: "decided", recoveryPolicyStamp: "old-policy", recoveryRetry: { attempts: 12, nextAt: 3600000, diagnostic: "invalid_response" } } } as never]);
  try {
    await h.recoverTasks(); assert.equal(assessments, 1); assert.equal(working, 0);
    const task = h.state("mem:room1").task!; assert.equal(task.depth, 3); assert.equal(task.recoveryRetry!.attempts, 13);
    assert.equal(task.recoveryPolicyStamp, "new-provider-contract"); await h.recoverTasks(); assert.equal(assessments, 1);
  } finally { await h.stop(0); }
});

test("settled Dispatcher report gets one fresh assessment on transport policy update without replaying worker or resetting counters", () => {
  const registry = new ValidatorRegistry(); registry.register({ apiVersion: 1, name: "typesafe-fixture", version: 2, requiresModel: false, maxPromptBytes: 56000, assess: async () => undefined }); registry.select("typesafe-fixture");
  const state = { v: 1, readyStepPolicy: 1, planner: { requested: {} }, plan: [{ task: "Complete original work", role: "simple", reason: "bounded", evidence: "actual result" }], outcomes: [],
    assessment: { index: 0, reply: "Existing result; STEP-STATUS: complete", tools: 2, evidence: [], attempts: 63, nextAt: 3600000, diagnostic: "invalid_response" },
    correction: { index: 0, rounds: 26, note: "Retain prior budgets" } };
  const task = { id: "owner", parent: "parent", requestId: "same", input: "Original scope", strategy: "sequential", strategyVersion: 1, status: "ready", restarts: 7,
    intent: { key: "step:owner:0:simple", replay: "unsafe", route: { model: "fixture" } }, checkpoint: JSON.stringify(state) } as Execution;
  const strategy = sequentialStrategy({ runtime: new FakeRuntime(), validators: registry, roles: () => undefined, runTurn: async () => { throw Error("Worker must not run"); } } as never);
  const first = strategy.refreshAssessment!(task, 1000); assert.ok(first);
  const updated = JSON.parse(first.checkpoint); assert.equal(updated.assessment.nextAt, 1000); assert.equal(updated.assessment.attempts, 63); assert.equal(updated.correction.rounds, 26);
  assert.equal(task.restarts, 7); assert.equal(strategy.refreshAssessment!({ ...task, checkpoint: first.checkpoint }, 1001), undefined);
  assert.equal(strategy.refreshAssessment!({ ...task, intent: { ...task.intent!, key: "unrelated-effect" } }, 1000), undefined);
  const opaque = { ...state }; delete (opaque as any).assessment;
  assert.equal(strategy.refreshAssessment!({ ...task, checkpoint: JSON.stringify(opaque) }, 1000), undefined);
});

test("one slow unrelated startup judge does not withhold an already durably admitted task", async () => {
  let blocked!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { blocked = r; }), gate = new Promise<void>(r => { release = r; });
  let ran!: () => void; const working = new Promise<void>(r => { ran = r; });
  const h = new Harness({ runtime: new FakeRuntime(() => { ran(); return "verified"; }), completionCheck: async i => {
    if (i.taskId === "slow") { blocked(); await gate; return { state: "blocked" }; }
    return { state: "completed" };
  } }); h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
  h.restoreSessions([{ key: "mem:room1", task: { id: "ready", original: "Already authorized retained task", state: "active", recoveryEnrollment: "current", depth: 0, next: "Inspect existing state",
    recoveryAdmission: { id: "ready:1", depth: 1, original: "Already authorized retained task", next: "Inspect existing state" } } },
    { key: "mem:room2", task: { id: "slow", original: "Separate retained task awaiting judge", state: "active", recoveryEnrollment: "current", depth: 0 } }] as never);
  const scan = h.recoverTasks(true);
  try { await entered; await working; assert.ok(h.sessions.get("mem:room1")); }
  finally { release(); await scan; await h.stop(0); }
});

test("graceful stop cancels a retained parent assessor waiting for capacity without granting continuation", async () => {
  let entered!: () => void; const waiting = new Promise<void>(r => { entered = r; }); let cancelled = false;
  const h = new Harness({ runtime: new FakeRuntime(() => { throw Error("No working turn"); }), completionCheck: async (_i, _r, signal) => {
    entered(); await new Promise<void>(resolve => { signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }); }); return { state: "continue", next: "Must not execute after stop" };
  } }); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", task: { id: "original", original: "Authorized retained task", recoveryEnrollment: "current", state: "active", depth: 2 } }] as never);
  const recovery = h.recoverTasks(true); await waiting; await h.stop(0); await recovery;
  assert.equal(cancelled, true); assert.equal(h.state("mem:room1").task!.depth, 2); assert.equal(h.state("mem:room1").task!.recoveryAdmission, undefined);
});
