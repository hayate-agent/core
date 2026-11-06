// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const busyMode of ["queue", "steer", "interrupt"] as const) {
  test(`${busyMode}: question during host afterTurn is not consumed by stale reply`, async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { entered = r; });
    const runtime = new FakeRuntime();
    const harness = new Harness({ runtime, busyMode, tickMs: 60000, hostEventAllowed: () => true,
      afterTurn: async (input, reply) => {
        if (input.source === "host") { entered(); await gate; }
        return reply;
      },
    });
    const ch = new MemoryChannel(); harness.addChannel(ch);
    harness.onStateChange = async () => {};
    await harness.accept({ id: "host", sessionKey: "mem:room1", source: "host", text: "old result", hostEvent: { executionId: "worker" } });
    await ready;
    await harness.accept({ ...msg("direct question"), id: "question" });
    assert.deepEqual(runtime.sessions.get("mem:room1")!.steered, []);
    assert.equal(runtime.sessions.get("mem:room1")!.aborted, 0);
    assert.ok(harness.pendingInputs().some(input => input.text === "direct question"));
    release(); await harness.drained();
    assert.equal(ch.texts().at(-1), "echo: direct question");
    assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["old result", "direct question"]);
    await harness.stop(1000);
  });
}
