import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { assessCompletion } from "./completion-selected.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

test("persisted independent admission queues once across restart; failure never leaves executable work", async () => {
  let checks = 0;
  const assess: NonNullable<ConstructorParameters<typeof Harness>[0]["completionCheck"]> = (input, reply, signal) =>
    assessCompletion({ review: async () => { checks++; return '{"state":"continue","next":"Read independent test results"}'; } },
      input, reply, { task: "Implement change" }, signal, undefined, Date.now, completionPrompt);
  const h = new Harness({ runtime: new FakeRuntime(), completionCheck: assess });
  h.addChannel(new MemoryChannel());
  h.restoreSessions([{ key: "mem:room1", tasks: [{ id: "retained", original: "Implement change", state: "active", depth: 0 }] }]);
  let fail = true;
  h.onStateChange = async () => {
    if (fail && h.pendingInputs().length) { fail = false; throw Error("deterministic persistence failure"); }
  };
  try {
    await assert.rejects(h.recoverTasks(), /persistence failure/);
    assert.equal(h.pendingInputs().length, 0);
    await h.recoverTasks(); await h.recoverTasks();
    assert.equal(h.pendingInputs().length, 1); assert.equal(checks, 1);
    const runtime = new FakeRuntime(() => "Independent results read");
    const next = new Harness({ runtime, completionCheck: (input, reply, signal) =>
      assessCompletion({ review: async () => '{"state":"completed"}' }, input, reply,
        { task: "Implement change" }, signal, undefined, Date.now, completionPrompt) });
    next.addChannel(new MemoryChannel()); next.onStateChange = async () => {};
    try {
      next.restoreSessions(JSON.parse(JSON.stringify(h.snapshotSessions())));
      next.restorePending(JSON.parse(JSON.stringify(h.pendingInputs())));
      await next.recoverTasks(); await next.recoverTasks();
      assert.equal(next.pendingInputs().length, 1);
      next.releaseRestored(); await next.drained();
      assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
      await next.recoverTasks(); await next.drained();
      assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
    } finally { await next.stop(0); }
  } finally { await h.stop(0); }
});
