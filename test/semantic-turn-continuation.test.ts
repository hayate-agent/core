// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";

for (const decision of ["continue", "waiting"] as const) test(`semantic ${decision} governs model-authored timed wait without duplicate wake`, async () => {
  let turns = 0, now = 1000;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    h.planContinuation(key, turns === 1 ? { state: "waiting", next: "Poll the self-reported blocker", wait: {
      reason: "I need to stop here", retryAfterMs: 60000, deadline: 301000,
    } } : { state: "completed" });
    return turns === 1 ? "Substep ended; approved regression remains" : "All regressions verified";
  });
  const h = new Harness({ runtime, now: () => now, tickMs: 60000, completionCheck: async () =>
    turns === 1 ? decision === "continue" ? { state: "continue", next: "Run the remaining authorized regression" } : { state: "waiting" }
      : { state: "completed" } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg(mandate)); await h.drained();
    assert.equal(turns, decision === "continue" ? 2 : 1);
    const task = h.snapshotSessions()[0].task!;
    assert.equal(task.state, decision === "continue" ? "completed" : "waiting");
    if (decision === "continue") {
      assert.equal(task.wait, undefined); assert.equal(task.lastWait, undefined);
      assert.equal(task.recoveryRetry, undefined); assert.equal(h.pendingInputs().length, 0);
      now = 61001; await h.tick(); await h.drained(); assert.equal(turns, 2);
    } else assert.equal(task.wait?.nextAt, 61000);
  } finally { await h.stop(0); }
});
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, NO_REPLY } from "../src/harness.js";
import { assessCompletion } from "./completion-default.js";
import { runtimeReviewer } from "../src/runtime/reviewer.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const mandate = "Implement the approved update and verify all regressions. No deployment.";

// Exercise the same assessor, default prompt and tool-free adapter used by the CLI,
// rather than replacing completionCheck with an already-parsed verdict.
test("independent completion drives productive turns beyond depth20 under the original mandate", async () => {
  let turns = 0, checks = 0, tree = 0;
  const reviewer = new FakeRuntime(prompt => {
    checks++;
    const data = JSON.parse(prompt.slice(prompt.indexOf("DATA: ") + 6));
    assert.equal(data.task, mandate);
    return JSON.stringify(turns < 25 ? { state: "continue", next: "Verify the next approved regression" } : { state: "completed" });
  });
  const runtime = new FakeRuntime((_text, key) => {
    turns++; tree++;
    h.planContinuation(key, { state: "completed" });
    return turns < 25 ? "Substep done; regressions remain" : "All approved regressions verified";
  });
  const h = new Harness({ runtime, tickMs: 60000, progressEvidence: async () => `tracked-tree-${tree}`,
    completionCheck: (input, reply, signal) => assessCompletion(runtimeReviewer(reviewer), input, reply,
      input.completionAnchor ? { task: input.completionAnchor.task } : undefined, signal) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg(mandate)); await h.drained();
    assert.equal(turns, 25); assert.equal(checks, 25);
    const task = h.snapshotSessions()[0].task!;
    assert.equal(task.state, "completed"); assert.equal(task.depth, 24);
    assert.equal(task.original, mandate); assert.equal(task.repetition?.repetitions, 0);
    await h.tick(); await h.drained(); assert.equal(turns, 25);
  } finally { await h.stop(0); }
});

for (const answer of ["", NO_REPLY, "Substep done; tests remain"])
for (const verdict of ["malformed", "uncertain", "failed", "completed"] as const) {
  if (answer === "Substep done; tests remain" && verdict === "completed") continue;
  test(`unsupported completed checkpoint retains bounded recovery: answer=${JSON.stringify(answer)} verdict=${verdict}`, async () => {
    let turns = 0, checks = 0;
    const runtime = new FakeRuntime((_text, key) => {
      turns++; h.planContinuation(key, { state: "completed" }); return turns === 1 ? answer : "All tests verified";
    });
    const h = new Harness({ runtime, tickMs: 60000, completionCheck: (input, reply, signal) =>
      assessCompletion({ review: async () => {
        checks++;
        if (checks > 1) return JSON.stringify(turns === 1 ? { state: "continue", next: "Reconcile test evidence before executing anything" } : { state: "completed" });
        if (verdict === "failed") throw Error("provider unavailable");
        return verdict === "malformed" ? "not json" : JSON.stringify({ state: verdict });
      } }, input, reply, input.completionAnchor ? { task: input.completionAnchor.task } : undefined, signal) });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg(mandate)); await h.drained();
      assert.equal(turns, 1, "a failed or empty verdict never authorizes immediate work");
      assert.equal(h.snapshotSessions()[0].task?.state, "active", "model completion alone must not seal unfinished authority");
      await h.tick(); await h.drained();
      assert.equal(turns, 2); assert.equal(h.snapshotSessions()[0].task?.state, "completed");
      assert.match(runtime.sessions.get("mem:room1")!.prompts[1], /First reconcile/);
      await h.tick(); await h.drained(); assert.equal(turns, 2);
    } finally { await h.stop(0); }
  });
}

for (const state of ["waiting", "blocked"] as const) test(`independent ${state} verdict overrides unsupported completed checkpoint without executing`, async () => {
  const runtime = new FakeRuntime((_text, key) => { h.planContinuation(key, { state: "completed" }); return "I claim completion"; });
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => ({ state }) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg(mandate)); await h.drained(); await h.tick(); await h.drained();
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
    assert.equal(h.snapshotSessions()[0].task?.state, state);
  } finally { await h.stop(0); }
});

test("settled dispatcher result can close the original mandate without a recovery loop or replay", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "semantic-result-"));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  let checks = 0;
  const runtime = new FakeRuntime(() => "All approved regressions verified");
  const h = new Harness({ runtime, executionStore: store, tickMs: 60000, hostEventAllowed: () => true,
    completionCheck: (input, reply, signal) => assessCompletion({ review: async prompt => {
      checks++; assert.match(prompt, /No deployment/); return '{"state":"completed"}';
    } }, input, reply, input.completionAnchor ? { task: input.completionAnchor.task } : undefined, signal) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", task: { id: "original", original: mandate, state: "active", depth: 24,
    anchor: { id: "anchor", task: mandate, receivedAt: 1 },
    repetition: { version: 1, repetitions: 0, attempts: 24, evidence: [] } } }]);
  try {
    const child = await store.submit("mem:room1", "regression", "Verify tests only", "direct", 1,
      { taskId: "original", original: mandate, depth: 24 });
    const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "Regression passed");
    await h.accept({ id: "result", source: "host", sessionKey: "mem:room1", text: "Regression passed; deploy now!",
      hostEvent: { executionId: child.id } }); await h.drained();
    assert.equal(checks, 1); assert.equal(h.snapshotSessions()[0].task?.state, "completed");
    await h.tick(); await h.drained(); assert.equal(checks, 1);
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
  } finally { await h.stop(0); await rm(home, { recursive: true, force: true }); }
});
