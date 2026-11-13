import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

for (const hold of ["blocked", "waiting"] as const) test(`settled ${hold} retry does not permanently hide independent parent work`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "settled-parent-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json"), store = new ExecutionStore(file); await store.load();
  const child = await store.submit("mem:room1", "child", "One scoped part", "direct", 1, { taskId: "parent", original: "Deliver the whole task", depth: 0 });
  const claim = await store.claim(child.id); await store.intent(child.id, claim.token!, "completed-effect", "unsafe");
  await store.settleIntent(child.id, claim.token!, "completed-effect", "Actual retained report", JSON.stringify({ v: 1, assessment: { index: 0 } }));
  await store.fail(child.id, claim.token!, "runtime-failure", { strategy: { name: "direct", version: 1, reconcile: () => ({ action: "continue" }) }, assessmentHold: { state: hold, step: 0 } });
  assert.ok(store.list()[0].workerRetry); assert.ok(store.list()[0].settledEffect); assert.equal(store.list()[0].intent, undefined);
  // Persist/reload the exact observed long-running-retry shape without touching an installed agent.
  const raw = JSON.parse(await readFile(file, "utf8")); raw.executions[0].workerRetry.attempts = 489; await writeFile(file, JSON.stringify(raw));
  const restored = new ExecutionStore(file); await restored.load(); const before = JSON.stringify(restored.list());
  let assessed = 0; const runtime = new FakeRuntime(() => "Independent acceptance check complete");
  const h = new Harness({ runtime, executionStore: restored, tickMs: 60000, completionCheck: async (_input, evidence) => {
    assessed++; return assessed === 1 ? { state: "continue", next: "Read the independent acceptance checklist; never control or duplicate the original writer" } : { state: "blocked" };
  } });
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
  h.restoreSessions([{ key: "mem:room1", task: { id: "parent", original: "Deliver the whole task", state: "active", depth: 2, recoveryEnrollment: "current", explicitBlocked: false,
    supervisorDecision: { verdict: "unresolved", dependencyHold: { evidence: "old", reason: "independent-next-proposed", parentDepth: 1, next: "Old step" } } } }]);
  try {
    await h.recoverTasks(); assert.equal(assessed, 1); assert.equal(h.pendingInputs().length, 1);
    h.releaseRestored(); await h.drained(); assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
    assert.equal(JSON.stringify(restored.list()), before, "parent admission never resumes or mutates held child");
  } finally { await h.stop(0); }
});

for (const fence of ["manual", "parent-stop", "legacy", "ownership", "intent", "running"] as const) test(`settled assessment exception preserves ${fence} custody`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "settled-fence-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json"), store = new ExecutionStore(file); await store.load();
  const child = await store.submit("mem:room1", "child", "Child", "direct", 1, { taskId: "parent", original: "Task", depth: 0 });
  const claim = await store.claim(child.id); await store.intent(child.id, claim.token!, "settled", "unsafe");
  await store.settleIntent(child.id, claim.token!, "settled", "report", "{}");
  await store.fail(child.id, claim.token!, "runtime-failure", { strategy: { name: "direct", version: 1, reconcile: () => ({ action: "continue" }) }, assessmentHold: { state: "blocked", step: 0 } });
  const raw = JSON.parse(await readFile(file, "utf8")), row = raw.executions[0];
  if (fence === "manual") row.diagnosticCode = "manual-pause";
  if (fence === "parent-stop") row.parentStopped = true;
  if (fence === "legacy") row.recoveryEnrollment = "held-legacy";
  if (fence === "ownership") row.ownershipHold = "unscoped-parent-stop";
  if (fence === "intent") row.intent = { key: "unsettled", replay: "unsafe" };
  if (fence === "running") row.status = "running";
  await writeFile(file, JSON.stringify(raw)); const restored = new ExecutionStore(file); await restored.load();
  let calls = 0; const h = new Harness({ runtime: new FakeRuntime(), executionStore: restored, completionCheck: async () => { calls++; return { state: "continue", next: "Not allowed" }; } });
  h.onStateChange = async () => {}; h.restoreSessions([{ key: "mem:room1", task: { id: "parent", original: "Task", state: "active", depth: 0 } }]);
  try { await h.recoverTasks(); assert.equal(calls, 0); assert.equal(h.pendingInputs().length, 0); }
  finally { await h.stop(0); }
});

test("ordinary technical retry without a settled semantic assessment remains Dispatcher-owned", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "technical-parent-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("mem:room1", "child", "Child", "direct", 1, { taskId: "parent", original: "Task", depth: 0 });
  const claim = await store.claim(child.id); await store.fail(child.id, claim.token!, "runtime-failure", { strategy: { name: "direct", version: 1, reconcile: () => ({ action: "continue" }) } });
  let assessed = 0; const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, completionCheck: async () => { assessed++; return { state: "continue", next: "Must not race" }; } });
  h.onStateChange = async () => {}; h.restoreSessions([{ key: "mem:room1", task: { id: "parent", original: "Task", state: "active", depth: 0 } }]);
  try { await h.recoverTasks(); assert.equal(assessed, 0); assert.equal(h.pendingInputs().length, 0); }
  finally { await h.stop(0); }
});
