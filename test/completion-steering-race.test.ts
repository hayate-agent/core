// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

test("stop during asynchronous steering cannot resurrect the independently retained mandate", async () => {
  const runtime = new FakeRuntime(() => "Not implemented");
  const h = new Harness({ runtime, busyMode: "steer", tickMs: 60000, completionCheck: async () => undefined });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Explain current state")); await h.drained();
    const session = runtime.sessions.get("mem:room1")!;
    const releasePrompt = session.hold();
    let releaseSteer!: () => void;
    const gate = new Promise<void>(resolve => { releaseSteer = resolve; });
    let entered = false;
    session.steer = async () => { entered = true; await gate; };
    await h.submit(msg("Explain further"));
    while (!h.state("mem:room1").prompting) await new Promise(resolve => setTimeout(resolve, 1));
    const accepted = h.submit(msg("Implement the approved repair"));
    while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
    await h.stopConversation("mem:room1");
    releaseSteer(); releasePrompt(); await accepted; await h.drained();
    const task = h.snapshotSessions()[0].tasks!.find(t => t.original === "Implement the approved repair");
    assert.ok(task); assert.equal(task.state, "stopped");
    assert.equal(session.prompts.length, 2);
  } finally { await h.stop(0); }
});
