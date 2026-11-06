// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryOrchestrationRegistry } from "../src/memory-orchestration.js";
import { memoryConfig, type MemoryTurn } from "../src/memory.js";
import { PluginHost } from "../src/plugins.js";
import { Harness } from "../src/harness.js";
import { SettingsService } from "../src/settings.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

class Orchestrator {
  recalled: string[] = []; captured: MemoryTurn[] = [];
  async recall(key: string, text: string) { this.recalled.push(key); return `Memory hint for ${text}`; }
  async capture(turn: MemoryTurn) { this.captured.push(turn); }
}
test("registry binds class methods, selects explicit implementations and none passes through", async () => {
  const registry = new MemoryOrchestrationRegistry(); const first = new Orchestrator(); const custom = new Orchestrator();
  assert.equal(await registry.recall("chat", "text"), "");
  registry.register("default", first); registry.register("custom", custom);
  registry.select("custom"); await registry.recall("chat", "text");
  assert.deepEqual(custom.recalled, ["chat"]); assert.deepEqual(first.recalled, []);
  assert.throws(() => registry.select("missing"), /Unknown/);
  await registry.recall("chat", "still selected"); assert.equal(custom.recalled.length, 2);
  registry.select("none"); assert.equal(await registry.recall("chat", "text"), "");
  registry.clear(); assert.throws(() => registry.select("custom"), /Unknown/);
  for (const value of [null, 12, {}, [], true]) assert.throws(() => memoryConfig({ orchestration: value as never }), /Invalid memory.orchestration/);
});

test("plugin selection drives actual Harness recall/capture; none suppresses both hooks", async () => {
  const host = new PluginHost(); const custom = new Orchestrator(); const baseline = new Orchestrator();
  host.memoryOrchestration.register("default", baseline);
  await host.load([], { home: "/tmp", cwd: "/tmp", agent: "test" }, [], [], [{ apiVersion: 1, activate(api) { api.registerMemoryOrchestrator("custom", custom); } }]);
  host.memoryOrchestration.select("custom");
  const runtime = new FakeRuntime(); const harness = new Harness({ runtime, memory: host.memoryOrchestration, tickMs: 60000 });
  harness.addChannel(new MemoryChannel()); harness.onStateChange = async () => {};
  try {
    await harness.submit(msg("original task")); await harness.drained();
    assert.equal(custom.captured.length, 1); assert.equal(baseline.captured.length, 0);
    assert.match(runtime.sessions.get("mem:room1")!.options[0].instructions!, /Memory hint/);
    host.memoryOrchestration.select("none");
    await harness.submit(msg("second task")); await harness.drained();
    assert.equal(custom.captured.length, 1); assert.equal(custom.recalled.length, 1);
    assert.doesNotMatch(runtime.sessions.get("mem:room1")!.options[1].instructions!, /Memory hint/);
    assert.match(runtime.sessions.get("mem:room1")!.options[1].instructions!, /20 consecutive stalled or unevidenced attempts/);
    await host.stop(); assert.equal(await host.memoryOrchestration.recall("chat", "text"), "");
  } finally { await harness.stop(1000); }
});

test("orchestration overlay survives reopen; failed plugin activation clears registrations", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-orchestration-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.yaml");
  const settings = new SettingsService(file, {}); await settings.load();
  await settings.setMemory({ orchestration: "custom", enabled: false });
  const reopened = new SettingsService(file, {}); await reopened.load();
  assert.equal(reopened.effective().memory?.orchestration, "custom");
  assert.equal(reopened.effective().memory?.enabled, false);
  const host = new PluginHost();
  await assert.rejects(host.load([], { home, cwd: home, agent: "test" }, [], [], [{ apiVersion: 1, activate(api) {
    api.registerMemoryOrchestrator("custom", new Orchestrator()); throw Error("failed activation");
  } }]), /failed activation/);
  assert.throws(() => host.memoryOrchestration.select("custom"), /Unknown/);
});
