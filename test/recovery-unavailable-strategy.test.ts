import test from "node:test";
import assert from "node:assert/strict";
import { assessCompletion } from "../src/completion-check.js";
import { runtimeReviewer } from "../src/runtime/reviewer.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

test("absent production strategy reports unavailable without inference, retry or fabricated completion", async () => {
  const reviewer = new FakeRuntime(() => { throw Error("must not infer without strategy"); });
  const h = new Harness({ runtime: new FakeRuntime(() => "Existing result; external receipt missing."), tickMs: 60000,
    completionCheck: (input, reply, signal, diagnostic) => assessCompletion(runtimeReviewer(reviewer), input, reply,
      { task: input.completionAnchor!.task }, signal, undefined, Date.now, undefined, diagnostic) });
  const ch = new MemoryChannel(); h.addChannel(ch); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Verify existing result")); await h.drained();
    const task = h.snapshotSessions()[0].tasks![0];
    assert.equal(task.state, "blocked"); assert.equal(task.explicitBlocked, false);
    assert.equal(task.recoveryRetry, undefined); assert.equal(reviewer.opened.length, 0);
    const text = ch.texts().find(t => t.includes("Recovery angehalten"))!;
    assert.match(text, /nicht konfiguriert/); assert.match(text, /UNVERIFIED EVIDENCE.*external receipt missing/);
    assert.doesNotMatch(text, /Entscheidung nötig|Bitte antworte|Soll dieser Auftrag/);
    await h.recoverTasks(); await h.tick(); await h.drained();
    assert.equal(ch.texts().filter(t => t.includes("Recovery angehalten")).length, 1);
  } finally { await h.stop(0); }
});
