import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { repetitions } from "../src/repetition-budget.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";

for (const mode of ["tool-free", "dispatcher-metadata"] as const) test(`${mode}: validator continue alone cannot indefinitely renew an unchanged mandate`, async t => {
  let turns = 0;
  const runtime = new FakeRuntime((_text, key) => {
    turns++;
    if (mode === "dispatcher-metadata") {
      const onEvent = runtime.sessions.get(key)!.options.at(-1)!.onEvent!;
      onEvent({ type: "tool", phase: "start", name: "plugin_dispatch", callId: String(turns) });
      onEvent({ type: "tool", phase: "end", name: "plugin_dispatch", callId: String(turns),
        detail: JSON.stringify({ tasks: [{ id: "same-worker", status: "completed", restarts: turns, result: "same completed result" }] }) });
    }
    return "Existing result unchanged; check it again.";
  });
  const h = new Harness({ runtime, now: () => 1000, completionCheck: async () => turns < 25
    ? { state: "continue", next: "Read the same completed result without repeating its effects" } : { state: "completed" } });
  t.after(() => h.stop(0)); h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
  await h.submit(msg("Inspect the existing result once")); await h.drained();
  assert.equal(turns, 20, "a fresh validation verdict or changing scheduler metadata is not task progress");
  assert.equal(repetitions(h.snapshotSessions()[0].tasks![0]), 20);
  assert.equal(h.snapshotSessions()[0].tasks![0].termination, "productive_budget_exhausted");
  await h.tick(); await h.drained(); assert.equal(turns, 20);
});

test("late worker result cannot reopen a completed current parent or mint a new Resume admission", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "terminal-parent-"));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const key = "mem:room1", original = "Read the existing receipt once";
  const child = await store.submit(key, "receipt", original, "direct", 1, {
    taskId: "old-completed", original, depth: 0, anchor: { id: "old-completed", task: original, receivedAt: 1, replyTo: ROOM },
  });
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "Receipt already verified");
  let checks = 0;
  const runtime = new FakeRuntime(() => "Late receipt retained; no work needed");
  const h = new Harness({ runtime, executionStore: store, hostEventAllowed: () => true, now: () => 1000,
    completionCheck: async () => ++checks === 1 ? { state: "continue", next: "Read the old receipt again" } : { state: "completed" } });
  t.after(async () => { await h.stop(0); await rm(home, { recursive: true, force: true }); });
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
  h.restoreSessions([{ key, replyTo: ROOM, tasks: [{ id: "old-completed", original, state: "completed", depth: 0,
    recoveryEnrollment: "current", lastReply: "Receipt verified and reported", anchor: { id: "old-completed", task: original, receivedAt: 1 } }] }]);
  await h.submit({ id: "late-result", sessionKey: key, source: "host", hostEvent: { executionId: child.id }, text: "Receipt already verified", replyTo: ROOM });
  await h.drained(); await h.tick(); await h.drained();
  assert.equal(checks, 0, "late data is not renewed task authority");
  assert.equal(runtime.sessions.get(key)!.prompts.length, 1, "delivery only, no automatic Resume turn");
  const parent = h.snapshotSessions()[0].tasks![0];
  assert.equal(parent.state, "completed"); assert.equal(parent.lastReply, "Receipt verified and reported");
  assert.equal(parent.recoveryAdmission, undefined);
});
