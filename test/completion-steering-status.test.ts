import assert from "node:assert/strict";
import test from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
const mandate = "Implement and test the approved policy";

for (const boundary of ["continue", "stop", "pause"] as const) {
  test(`not-implemented status retains older authorization and respects ${boundary}`, async () => {
    let statusAsked = false;
    let h: Harness;
    const runtime = new FakeRuntime(() => "No, saved but not implemented");
    h = new Harness({ runtime, tickMs: 60000, completionCheck: async input => {
      if (input.source === "heartbeat" && input.text === mandate) {
        if (!statusAsked) return undefined;
        if (boundary === "stop") await h.stopConversation(key);
        if (boundary === "pause") h.paused = true;
        return { state: "continue", next: "Inspect existing configuration before applying the approved policy" };
      }
      return { state: "completed" };
    } });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    h.restoreSessions([{ key, tasks: [{ id: "authorized", original: mandate, state: "active", depth: 0,
      anchor: { id: "anchor", task: mandate, receivedAt: 1 } }] }]);
    try {
      statusAsked = true;
      await h.submit(msg("Have you implemented it now?")); await h.drained();
      const task = h.snapshotSessions()[0].tasks!.find(t => t.id === "authorized")!;
      const prompts = runtime.sessions.get(key)!.prompts;
      if (boundary === "continue") {
        assert.equal(task.state, "completed");
        assert.equal(prompts.length, 2);
        assert.match(prompts[1], /First reconcile the actual task state and completed side effects/);
        assert.ok(h.snapshotSessions()[0].tasks!.some(t => t.original === "Have you implemented it now?" && t.state === "completed"));
      } else {
        assert.equal(prompts.length, 1, "no coding after explicit host stop/pause");
        assert.equal(task.state, boundary === "stop" ? "stopped" : "active");
      }
    } finally { await h.stop(0); }
  });
}
