import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, NO_REPLY } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { PromptOptions } from "../src/types.js";

for (const scenario of ["success", "error", "checkpoint-only", "no-checkpoint", "validator-continue"] as const) {
  test(`silent terminal settlement: ${scenario}`, async () => {
    let h!: Harness, calls = 0;
    const runtime = new FakeRuntime((_text, key) => {
      calls++;
      if (scenario !== "no-checkpoint") h.planContinuation(key, { state: "completed" });
      return NO_REPLY;
    });
    const open = runtime.open.bind(runtime);
    runtime.open = async (...args) => {
      const s = await open(...args), prompt = s.prompt.bind(s);
      s.prompt = async (text: string, options: PromptOptions = {}) => {
        if (scenario !== "checkpoint-only") options.onEvent?.({ type: "tool", phase: "end", name: "read", error: scenario === "error", detail: "checked" });
        return prompt(text, options);
      };
      return s;
    };
    h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => scenario === "validator-continue" ? (calls === 1 ? { state: "continue", next: "Verify remaining work" } : undefined) : { state: "completed" } });
    h.onStateChange = async () => {}; const channel = new MemoryChannel(); h.addChannel(channel);
    try {
      await h.submit(msg("Check the existing result silently.")); await h.drained();
      const task = h.snapshotSessions()[0]!.tasks![0]!;
      if (scenario === "success") { assert.equal(task.state, "completed"); assert.equal(calls, 1); }
      else assert.notEqual(task.state, "completed", "silence or failed evidence must not establish completion");
      assert.deepEqual(channel.sent, []);
    } finally { await h.stop(0); }
  });
}
