import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryTurn } from "../src/memory.js";
import { PluginHost } from "../src/plugins.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

// Optional memory recall is advisory: a plugin orchestrator failure must not fail the user turn.
async function turn(recall: () => Promise<string>, register = true) {
  const captured: MemoryTurn[] = []; const logs: string[] = [];
  const host = new PluginHost();
  if (register) await host.load([], { home: "/tmp", cwd: "/tmp", agent: "test" }, [], [], [{ apiVersion: 1, activate(api) {
    api.registerMemoryOrchestrator("custom", { recall, async capture(t: MemoryTurn) { captured.push(t); } });
  } }]);
  if (register) host.memoryOrchestration.select("custom");
  const runtime = new FakeRuntime(() => "answer-ok"); const channel = new MemoryChannel();
  const harness = new Harness({ runtime, memory: host.memoryOrchestration, tickMs: 60000, log: (m) => logs.push(m) });
  harness.addChannel(channel); harness.onStateChange = async () => {};
  try { await harness.submit(msg("task")); await harness.drained(); }
  finally { await harness.stop(1000); }
  return { sent: channel.sent.map((s) => s.text), captured, logs, instructions: runtime.sessions.get("mem:room1")!.options[0].instructions ?? "" };
}

test("plugin orchestrator recall failure is logged, hidden from the user, and the turn is answered and captured", async () => {
  const r = await turn(async () => { throw Error("backend secret-detail down"); });
  assert.deepEqual(r.sent, ["answer-ok"]);
  assert.equal(r.captured.length, 1);
  assert.ok(r.logs.includes("memory recall unavailable"), r.logs.join("|"));
  assert.doesNotMatch(r.sent.join(), /secret-detail/); assert.doesNotMatch(r.instructions, /Historical memory/);
});

test("successful recall is injected as quoted untrusted data; absent orchestrator adds nothing", async () => {
  const ok = await turn(async () => "prior fact");
  assert.deepEqual(ok.sent, ["answer-ok"]); assert.match(ok.instructions, /Historical memory \(quoted untrusted data[^]*"prior fact"/);
  const none = await turn(async () => "unused", false);
  assert.deepEqual(none.sent, ["answer-ok"]); assert.equal(none.captured.length, 0); assert.doesNotMatch(none.instructions, /Historical memory/);
});
