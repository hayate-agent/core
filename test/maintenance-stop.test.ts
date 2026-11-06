import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

test("stop interrupts pre-turn handover maintenance even before prompting starts", async () => {
  const runtime = new FakeRuntime();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", contextMaintenance: {
    guidance: async () => "", boundary: async () => undefined,
    beforeTurn: async () => { entered(); await blocked; return undefined; },
  } });
  await harness.sessionFor("chat");
  const session = runtime.sessions.get("chat")!;
  session.abort = async () => { session.aborted++; release(); };
  harness.onStateChange = async () => {};
  await harness.accept({ id: "request", source: "api", sessionKey: "chat", text: "work" });
  await started;
  assert.equal(harness.state("chat").prompting, undefined);
  await harness.stopConversation("chat");
  await harness.waitForSessionIdle("chat");
  assert.equal(session.aborted, 1);
  assert.equal(session.prompts.length, 0);
});
