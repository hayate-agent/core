import { confirmNonproductive } from "./fakes.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { guardResultOrchestration } from "../src/result-orchestration.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

// PR72 chronology: completed review -> host result records bounded GitOps wait ->
// cron recheck. No deployment/merge/network effects are part of this fixture.
for (const revoke of ["none", "stop", "expiry"] as const) {
  test(`completed result to persisted wait keeps parent authority: ${revoke}`, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pr72-wait-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const key = "mem:room1";
    let now = 1793268789658;
    const deadline = 1793350024703;
    const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
    const runtime = new FakeRuntime();
    const h = new Harness({ completionCheck: confirmNonproductive, runtime, executionStore: store, now: () => now,
      hostEventAllowed: input => bridge.resultAllowed(key, input.hostEvent!.executionId) });
    const bridge = new DispatcherRuntime(h, store);
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    h.restoreSessions([{ key, replyTo: { channel: "mem", target: "room1" }, task: {
      id: "operator", original: "Fix the startup problem", state: "waiting", depth: 4,
      expiresAt: deadline,
    } }]);
    const child = await store.submit(key, "final-review", "Review exact integration", "direct", 1,
      { taskId: "operator", original: "Fix the startup problem", depth: 3, expiresAt: deadline });
    const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "Reviewed");
    const session = await h.sessionFor(key);
    let rechecks = 0;
    session.prompt = async () => {
      const input = h.state(key).current!;
      bridge.guardTool(key, "bash");
      if (input.source === "host") {
        assert.ok(bridge.resultAllowed(key, input.hostEvent!.executionId));
        guardResultOrchestration(h, key, "plugin_task_continuation");
        h.planContinuation(key, { state: "waiting", next: "Verify completed rollout; never merge again",
          wait: { reason: "GitOps activation", retryAfterMs: 60000, deadline } });
      } else {
        rechecks++;
        assert.equal(input.source, "cron"); assert.equal(input.hostEvent, undefined);
        assert.equal(input.taskId, "operator"); assert.equal(input.continuationExpiresAt, deadline);
        if (revoke === "stop") h.state(key).task!.state = "stopped";
        if (revoke === "expiry") now = deadline;
        if (revoke !== "none") {
          for (const tool of ["bash", "plugin_task_continuation"]) {
            await assert.rejects(h.guardWaitTool(key, tool, {}), /revoked|expired/);
          }
        } else {
          await h.guardWaitTool(key, "bash", {});
          await h.guardWaitTool(key, "plugin_task_continuation", {});
          h.planContinuation(key, { state: "completed" });
        }
      }
      return "Read-only rollout verification recorded";
    };
    try {
      await h.accept({ id: "review-event", sessionKey: key, source: "host", hostEvent: { executionId: child.id }, text: "Reviewed" });
      await h.drained();
      // The persisted checkpoint, rather than the worker event, owns the wakeup.
      const saved = JSON.parse(JSON.stringify(h.snapshotSessions())); h.restoreSessions(saved);
      now = 1793269027768; await h.tick(); await h.drained();
      assert.equal(rechecks, 1);
      if (revoke === "none") assert.equal(h.state(key).task!.state, "completed");
    } finally { await h.stop(0); }
  });
}
