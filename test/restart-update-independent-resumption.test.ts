import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, type DurableTask } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

for (const mode of ["restart", "update"] as const) for (const legacy of [false, true]) test(`${mode}: consumed ${legacy ? "legacy" : "versioned"} independent step gets fresh assessment, not permanent hold or old proposal replay`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "resume-step-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("mem:room1", "child", "Modify original component", "direct", 1, { taskId: "parent", original: "Deliver original component", depth: 0 });
  const claim = await store.claim(child.id); await store.intent(child.id, claim.token!, "unknown-external-effect", "unsafe"); await store.fail(child.id, claim.token!, "runtime-failure");
  const before = JSON.stringify(store.list().find(e => e.id === child.id));
  const task: DurableTask = { id: "parent", original: "Deliver original component", recoveryEnrollment: "current", state: "active", depth: 2, explicitBlocked: false,
    anchor: { id: "original", task: "Deliver original component", receivedAt: 1 },
    supervisorDecision: { verdict: "unresolved", dependencyHold: { reason: "independent-next-proposed", evidence: "prior", next: "NEVER REPLAY THIS OLD PROPOSAL", ...(legacy ? {} : { parentDepth: 1 }) } } };
  await writeFile(path.join(dir, "sessions.json"), JSON.stringify([{ key: "mem:room1", task, replyTo: { channel: "mem", target: "room1" } }]));
  let assessments = 0, workingTurns = 0;
  const runtime = new FakeRuntime(text => { workingTurns++; assert.match(text, /Read a different acceptance record/); assert.doesNotMatch(text, /NEVER REPLAY/); return "Independent record inspected"; });
  const h = new Harness({ runtime, executionStore: store, tickMs: 60000,
    completionCheck: async (_input, evidence) => {
      assessments++;
      if (assessments === 1) { assert.match(evidence, /dependencyReconciliation/); return { state: "continue", next: "Read a different acceptance record without controlling the blocked writer" }; }
      return { state: "blocked" };
    } });
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
  h.restoreSessions(JSON.parse(await readFile(path.join(dir, "sessions.json"), "utf8")));
  try {
    await h.recoverTasks(); assert.equal(assessments, 1); assert.equal(h.pendingInputs().length, 1);
    h.releaseRestored(); await h.drained(); assert.equal(workingTurns, 1);
    assert.equal(JSON.stringify(store.list().find(e => e.id === child.id)), before, "child intent/checkpoint/effects stay unchanged");
    await assert.rejects(store.claim(child.id));
  } finally { await h.stop(0); }
});

for (const fence of ["stopped", "paused", "semantic", "same-depth", "budget", "expired", "held-legacy"] as const) test(`spent independent marker cannot cross ${fence}`, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "resume-fence-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("mem:room1", "child", "Old writer", "direct", 1, { taskId: "parent", original: "Authorized task", depth: 0 });
  const claim = await store.claim(child.id); await store.intent(child.id, claim.token!, "effect", "unsafe"); await store.fail(child.id, claim.token!, "runtime-failure");
  let calls = 0; const runtime = new FakeRuntime();
  const h = new Harness({ runtime, executionStore: store, now: () => 1000, completionCheck: async () => { calls++; return { state: "continue", next: "Not authorized" }; } });
  h.onStateChange = async () => {}; if (fence === "paused") h.paused = true;
  const task: DurableTask = { id: "parent", original: "Authorized task", state: fence === "stopped" ? "stopped" : "active", depth: 2,
    recoveryEnrollment: fence === "held-legacy" ? "held-legacy" : "current", explicitBlocked: fence === "semantic",
    ...(fence === "budget" ? { repetition: { version: 1 as const, repetitions: 20, attempts: 20, evidence: [] } } : {}),
    ...(fence === "expired" ? { expiresAt: 999 } : {}),
    supervisorDecision: { verdict: "unresolved", dependencyHold: { evidence: "prior", parentDepth: fence === "same-depth" ? 2 : 1, reason: "independent-next-proposed", next: "Old proposal" } } };
  h.restoreSessions([{ key: "mem:room1", task }]);
  try { await h.recoverTasks(); assert.equal(calls, 0); assert.equal(h.pendingInputs().length, 0); assert.equal(runtime.sessions.size, 0); }
  finally { await h.stop(0); }
});
