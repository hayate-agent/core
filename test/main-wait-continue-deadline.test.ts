import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
const original = "Investigate and fix the product bug; preserve the existing worker";
const final = "Accepted the product fix; no completed fix is claimed.";
const deadline = 301000;

for (const assessedExpiry of [undefined, 900000, 201000]) {
  test(`Main wait -> continue preserves the scheduling deadline (assessed expiry ${assessedExpiry})`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "main-wait-deadline-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const file = path.join(home, "executions.json");
    const store = new ExecutionStore(file); await store.load();
    const child = await store.submit(key, "existing-owner", "Implement the product fix", "direct", 1,
      { taskId: "operator-task", depth: 0, original });
    await store.claim(child.id);
    const childBefore = JSON.parse(await readFile(file, "utf8"));
    let now = 1000;
    const runtime = new FakeRuntime(() => {
      h.planContinuation(key, { state: "waiting", next: "Inspect existing worker status",
        wait: { reason: "Confirm worker execution", retryAfterMs: 60000, deadline } });
      return final;
    });
    let checks = 0;
    const h = new Harness({ runtime, executionStore: store, now: () => now, tickMs: 600000,
      completionCheck: async (input, reply) => {
        checks++;
        assert.equal(input.taskId, "operator-task");
        assert.ok(reply.startsWith(final), "Main's actual final is assessment evidence");
        return { state: "continue", next: "Read the existing worker checkpoint",
          ...(assessedExpiry === undefined ? {} : { expiresAt: assessedExpiry }) };
      } });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.accept({ ...msg(original, "operator-task"), id: "operator-task" }); await h.drained();
      const task = h.snapshotSessions()[0].tasks!.find(t => t.id === "operator-task")!;
      // Record the actual symptom even on the unpatched baseline, before assertions.
      t.diagnostic(JSON.stringify({ state: task.state, verdict: task.supervisorDecision,
        expiry: task.expiresAt ?? null, hasWait: !!task.wait, admission: task.recoveryAdmission?.id,
        turns: runtime.sessions.get(key)!.prompts.length, pending: h.pendingInputs().length }));
      assert.equal(task.state, "active");
      assert.equal(task.wait, undefined, "continue deliberately replaces the nonproductive timer");
      assert.equal(task.expiresAt, Math.min(deadline, assessedExpiry ?? Infinity),
        "a supervisor plan must not silently discard or extend the registered scheduling window");
      assert.equal(task.recoveryAdmission?.expiresAt, task.expiresAt);
      assert.equal(task.recoveryAdmission?.original, original);
      assert.equal(task.lastReply, final);
      assert.equal(task.supervisorDecision?.proposal, "waiting");
      assert.equal(task.supervisorDecision?.verdict, "continue");
      assert.equal(task.recoveryAdmission?.independent, undefined);
      now = 61000;
      await h.tick(); await h.drained();
      assert.equal(runtime.sessions.get(key)!.prompts.length, 1,
        "this focused fix does NOT bypass the running-child gate or restore the 60s monitor");
      assert.equal(checks, 1);
      assert.equal(h.pendingInputs().length, 0);
      const childAfter = JSON.parse(await readFile(file, "utf8"));
      assert.deepEqual(childAfter.executions, childBefore.executions, "no worker replay, cancellation or ownership rewrite");
      assert.deepEqual(childAfter.events, childBefore.events, "no worker-control event");

      const saved = JSON.parse(JSON.stringify(h.snapshotSessions()));
      let resumed = 0;
      const restarted = new Harness({ runtime: new FakeRuntime(() => { resumed++; return "unexpected"; }),
        now: () => Math.min(deadline, assessedExpiry ?? Infinity), tickMs: 600000,
        completionCheck: async () => { throw Error("an expired admission cannot request a new assessment"); } });
      restarted.onStateChange = async () => {};
      restarted.restoreSessions(saved);
      try {
        await restarted.recoverTasks(); await restarted.drained();
        assert.equal(resumed, 0, "serialized admission cannot run beyond the retained scheduling deadline");
      } finally { await restarted.stop(0); }
    } finally { await h.stop(0); }
  });
}

test("Main wait -> continue without a worker inherits the deadline on the next turn", async () => {
  let turns = 0;
  const runtime = new FakeRuntime(() => {
    if (++turns === 1) h.planContinuation(key, { state: "waiting", next: "Inspect evidence",
      wait: { reason: "Evidence is arriving", retryAfterMs: 60000, deadline } });
    return "Evidence checked";
  });
  const h = new Harness({ runtime, now: () => 1000, tickMs: 600000,
    completionCheck: async input => {
      if (turns === 1) return { state: "continue", next: "Inspect available evidence now" };
      assert.equal(input.continuationExpiresAt, deadline);
      return { state: "completed" };
    } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.accept(msg(original)); await h.drained();
    assert.equal(turns, 2);
    assert.equal(h.snapshotSessions()[0].task!.expiresAt, deadline);
  } finally { await h.stop(0); }
});
