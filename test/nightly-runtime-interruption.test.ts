import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, ROOM } from "./fakes.js";

test("nightly runtime interruption skips successful afterTurn and does not immediately replay", async t => {
  let attempts = 0;
  let completions = 0;
  const runtime = new FakeRuntime(() => {
    attempts++;
    throw new Error("Model request interrupted without host cancellation");
  });
  const harness = new Harness({ runtime, tickMs: 60000,
    afterTurn: async (_input, reply) => { completions++; return reply; }, log: () => {} });
  const channel = new MemoryChannel();
  harness.addChannel(channel); harness.home = ROOM;
  t.after(async () => { await harness.stop(0); });
  harness.enqueue({ id: "improvement:2026-11-23:2", sessionKey: "improvement:nightly", source: "cron", text: "Reconcile existing effects before continuing" });
  await harness.drained();
  assert.equal(attempts, 1);
  assert.equal(completions, 0, "nightly completed hook must not receive an empty success");
  assert.equal(harness.sessions.get("improvement:nightly")!.queue.length, 0);
});
