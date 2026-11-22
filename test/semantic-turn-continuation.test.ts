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
for (const changed of [false, true]) test(`silent waiting with ${changed ? "changed" : "identical"} read evidence`, async () => {
  let turns = 0, h!: Harness;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    if (turns > 2) { h.planContinuation(key, { state: "completed" }); return "Work completed"; }
    const event = runtime.sessions.get(key)!.options.at(-1)!.onEvent;
    event?.({ type: "tool", phase: "start", name: "read", callId: `r${turns}` });
    event?.({ type: "tool", phase: "end", name: "read", callId: `r${turns}`, detail: changed ? `result ${turns}` : "same result" });
    h.planContinuation(key, { state: "waiting", next: "Await clarification" }); return NO_REPLY;
  });
  h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => turns <= 2
    ? { state: "continue", next: "Inspect retained task" } : { state: "completed" } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Original task")); await h.drained();
    assert.equal(turns, 2, "different reads alone must not override a repeated silent wait");
    assert.equal(h.snapshotSessions()[0]!.task!.state, "waiting"); await h.tick(); await h.drained(); assert.equal(turns, 2);
  } finally { await h.stop(0); }
});

for (const advanced of [false, true]) test(`silent external wait with reworded checker next, progress=${advanced}`, async () => {
  let turns = 0, now = 1000;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    h.planContinuation(key, turns > 2 ? { state: "completed" } : { state: "waiting", next: "Await authentic Support reply", wait: {
      reason: "Support has not replied", retryAfterMs: 60000, deadline: 301000,
    } });
    return turns > 2 ? "Verified result" : NO_REPLY;
  });
  const h = new Harness({ runtime, now: () => now, tickMs: 60000, completionCheck: async () => turns > 2
    ? { state: "completed" } : { state: "continue", next: `Reconcile Support evidence, revision ${turns}`,
      ...(advanced ? { progress: { advanced: true, reason: "Independent new verification" } } : {}) } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Wait for Support and incorporate its result")); await h.drained();
    assert.equal(turns, advanced ? 3 : 2);
    const task = h.snapshotSessions()[0].task!;
    assert.equal(task.state, advanced ? "completed" : "waiting");
    if (!advanced) {
      assert.equal(task.wait?.nextAt, 61000);
      await h.tick(); await h.drained(); assert.equal(turns, 2, "no model polling before the real wait boundary");
      now = 61001; await h.tick(); await h.drained(); assert.equal(turns, 3, "existing bounded wake remains usable");
    }
  } finally { await h.stop(0); }
});

for (const advanced of [false, true]) test(`Minerva: changing history/status/shell evidence with reworded next, progress=${advanced}`, async () => {
  let turns = 0, h!: Harness;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    const event = runtime.sessions.get(key)!.options.at(-1)!.onEvent;
    for (const name of ["plugin_session_history", "plugin_dispatch", "bash"]) {
      const callId = `${name}-${turns}`;
      event?.({ type: "tool", phase: "start", name, callId });
      event?.({ type: "tool", phase: "end", name, callId, detail: `${name} probe ${turns}: dependency still unavailable` });
    }
    h.planContinuation(key, turns > 2 ? { state: "completed" } : { state: "waiting", next: `Await Mail/Slack recovery; retained evidence ${turns}` });
    return turns > 2 ? "Verified business result" : NO_REPLY;
  });
  h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => turns > 2 ? { state: "completed" } : {
    state: "continue", next: `Reconcile retained mail evidence, variant ${turns}`,
    ...(advanced ? { progress: { advanced: true, reason: "Verified new delivery receipt" } } : {}),
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Restore requested Mail/Slack reports without replaying uncertain deliveries")); await h.drained();
    assert.equal(turns, advanced ? 3 : 2);
    assert.equal(h.snapshotSessions()[0]!.task!.state, advanced ? "completed" : "waiting");
    if (!advanced) { await h.tick(); await h.drained(); assert.equal(turns, 2); }
  } finally { await h.stop(0); }
});

test("Odo: productive silent batch continuations are not treated as waiting", async () => {
  let turns = 0, h!: Harness;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    const event = runtime.sessions.get(key)!.options.at(-1)!.onEvent;
    event?.({ type: "tool", phase: "start", name: "bash", callId: `batch-${turns}` });
    event?.({ type: "tool", phase: "end", name: "bash", callId: `batch-${turns}`, detail: `Verified next batch item ${turns}` });
    h.planContinuation(key, turns < 5 ? { state: "continue", next: `Reconcile batch item ${turns + 1}` } : { state: "completed" });
    return turns < 5 ? NO_REPLY : "Batch verified";
  });
  h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => turns < 5
    ? { state: "continue", next: `Reconcile batch item ${turns + 1}` } : { state: "completed" } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try { await h.submit(msg("Process authorized batch with exact receipts")); await h.drained();
    assert.equal(turns, 5); assert.equal(h.snapshotSessions()[0]!.task!.state, "completed");
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
    let turns = 0, checks = 0, now = Date.now();
    const runtime = new FakeRuntime((_text, key) => {
      turns++; h.planContinuation(key, { state: "completed" }); return turns === 1 ? answer : "All tests verified";
    });
    const h = new Harness({ runtime, now: () => now, tickMs: 60000, completionCheck: (input, reply, signal) =>
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
      now = h.snapshotSessions()[0].task!.recoveryRetry!.nextAt;
      await h.tick(); await h.drained();
      assert.equal(turns, 2); assert.equal(h.snapshotSessions()[0].task?.state, "completed");
      assert.match(runtime.sessions.get("mem:room1")!.prompts[1], /Reconcile test evidence before executing anything/);
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
