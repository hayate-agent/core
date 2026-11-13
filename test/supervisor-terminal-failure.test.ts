import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { assessCompletion } from "./completion-selected.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";

for (const state of ["waiting", "blocked", "completed"] as const) {
  for (const failure of ["missing", "undefined", "error", "invalid"] as const) {
    test(`unassessed ${state} after admitted work is not terminal: ${failure}`, async () => {
      let h: Harness;
      let turns = 0, checks = 0;
      const runtime = new FakeRuntime(() => {
        turns++;
        h.planContinuation("mem:room1", turns === 1 ? { state: "continue", next: "Run the authorized isolated test" } :
          { state, next: "Deployment pending", ...(state === "waiting" ? { wait: { reason: "Deployment pending", retryAfterMs: 60000, deadline: Date.now() + 300000 } } : {}) });
        return "Deployment pending; independent isolated test remains authorized";
      });
      const options: ConstructorParameters<typeof Harness>[0] = { runtime, tickMs: 60000,
        completionCheck: (input, reply, signal, diagnostic) => assessCompletion({ review: async () => {
          if (++checks === 1) {
            if (failure === "missing") options.completionCheck = undefined;
            return JSON.stringify({ state: "continue", next: "Run the authorized isolated test" });
          }
          if (failure === "error") throw Error("backend unavailable");
          if (failure === "invalid") return '{"state":"continue","next":""}';
          return "";
        } }, input, reply, { task: input.completionAnchor!.task }, signal, undefined, Date.now, completionPrompt, diagnostic) };
      h = new Harness(options);
      h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
      try {
        await h.submit(msg("Run the independent isolated test; deployment is not a dependency"));
        await h.drained();
        const task = h.snapshotSessions()[0].tasks![0];
        assert.equal(turns, 2);
        assert.equal(task.state, "active", "failure cannot ratify the model's terminal/wait claim");
        assert.equal(task.explicitBlocked, false);
        assert.equal(task.wait, undefined);
        assert.equal(task.next, undefined);
        assert.equal(task.recoveryAdmission, undefined);
        assert.equal(h.pendingInputs().length, 0, "uncertainty never admits productive work");
        assert.deepEqual(task.supervisorDecision, { proposal: state, verdict: "unresolved",
          diagnostic: failure === "missing" ? "unavailable" : failure === "error" ? "technical" : "invalid_response",
          ...(failure === "missing" ? {} : { detail: { cause: failure === "error" ? "provider_error" : "invalid_shape" } }) });
        const restored = new Harness({ runtime: new FakeRuntime(), tickMs: 60000,
          now: () => Math.max(Date.now(), task.recoveryRetry?.nextAt ?? 0),
          completionCheck: async () => ({ state: "continue", next: "Inspect the isolated test result without repeating uncertain effects" }) });
        restored.addChannel(new MemoryChannel()); restored.onStateChange = async () => {};
        try {
          restored.restoreSessions(h.snapshotSessions()); await restored.recoverTasks();
          const recovered = restored.snapshotSessions()[0].tasks![0];
          assert.equal(recovered.original, task.original);
          assert.deepEqual(recovered.supervisorDecision, { proposal: state, verdict: "continue" }, "a new independent decision supersedes the old non-decision");
          assert.equal(restored.pendingInputs().length, 1);
          assert.equal(restored.pendingInputs()[0].id, recovered.recoveryAdmission!.id);
        } finally { await restored.stop(0); }
      } finally { await h.stop(0); }
    });
  }
}
