import test from "node:test";
import assert from "node:assert/strict";
import { assessCompletion } from "../src/completion-check.js";
import { runtimeReviewer } from "../src/runtime/reviewer.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

test("absent production strategy holds work without inference or productive reconciliation", async () => {
  const reviewer = new FakeRuntime(() => { throw Error("must not infer without strategy"); });
  let turns = 0;
  const runtime = new FakeRuntime(() => {
    if (++turns > 1) h.planContinuation("mem:room1", { state: "completed" });
    return "Existing result verified; no effects repeated.";
  });
  const h = new Harness({ runtime, tickMs: 60000,
    completionCheck: (input, reply, signal, diagnostic) => assessCompletion(runtimeReviewer(reviewer), input, reply,
      { task: input.completionAnchor!.task }, signal, undefined, Date.now, undefined, diagnostic) });
  const ch = new MemoryChannel(); h.addChannel(ch); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Verify existing result")); await h.drained();
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
    assert.equal(h.pendingInputs().length, 0);
    await h.tick(); await h.drained();
    assert.equal(turns, 1); assert.equal(reviewer.opened.length, 0);
    assert.equal(h.snapshotSessions()[0].tasks![0].state, "blocked");
    assert.equal(h.snapshotSessions()[0].tasks![0].recoveryAdmission, undefined);
    assert.equal(ch.texts().some(t => t.includes("Recovery angehalten")), false);
    await h.tick(); await h.drained(); assert.equal(turns, 1);
  } finally { await h.stop(0); }
});
