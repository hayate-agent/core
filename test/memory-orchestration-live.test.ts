// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import { memoryOrchestrationPlugin } from "../src/builtin-plugins/memory-orchestration-plugin.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { installCommands } from "../src/commands.js";

test("admin memory strategy switch persists and applies atomically, rejects busy/unknown and restores after restart", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-live-"));
  const settings = new SettingsService(path.join(home, "settings.yaml"), { memory: { orchestration: "default" } }); await settings.load();
  const host = new PluginHost(); const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  host.memoryOrchestration.register("default", { recall: async () => "baseline", capture: async () => {} });
  host.memoryOrchestration.register("custom", { recall: async () => "custom", capture: async () => {} });
  host.memoryOrchestration.select("default");
  try {
    await host.load([], { home, cwd: home, agent: "test" }, [], [], [memoryOrchestrationPlugin(host.memoryOrchestration, settings, h, true)]);
    const command = host.commands.get("memory-orchestration")!;
    assert.equal(command.admin, true);
    const run = (text: string) => command.run(text, {} as any);
    await run("use custom"); assert.equal(await host.memoryOrchestration.recall("chat", "x"), "custom");
    const reopened = new SettingsService(settings.file, {}); await reopened.load();
    assert.equal(reopened.effective().memory?.orchestration, "custom");
    host.memoryOrchestration.select(reopened.effective().memory?.orchestration); assert.equal(host.memoryOrchestration.active, "custom");
    await assert.rejects(run("use missing"), /Unknown/); assert.equal(host.memoryOrchestration.active, "custom");
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const reserved = h.atIdleBoundary(async () => { await gate; });
    await assert.rejects(run("disable"), /idle turn boundary/); release(); await reserved;
    assert.equal(host.memoryOrchestration.active, "custom");
    const save = settings.setMemory.bind(settings); settings.setMemory = async () => { throw Error("disk offline"); };
    await assert.rejects(run("disable"), /disk offline/); assert.equal(host.memoryOrchestration.active, "custom");
    settings.setMemory = save; await run("disable"); assert.equal(await host.memoryOrchestration.recall("chat", "x"), "");
    assert.equal(settings.effective().memory?.orchestration, "none");
    assert.match(String(await run("status")), /"active":"none"/);
    const disabled = new PluginHost();
    disabled.memoryOrchestration.register("default", { recall: async () => "baseline", capture: async () => {} });
    try {
      await disabled.load([], { home, cwd: home, agent: "test" }, [], [], [memoryOrchestrationPlugin(disabled.memoryOrchestration, settings, h, false)]);
      const disabledRun = (text: string) => disabled.commands.get("memory-orchestration")!.run(text, {} as any);
      await assert.rejects(disabledRun("use default"), /disabled at startup/);
      assert.equal(settings.effective().memory?.orchestration, "none");
      await disabledRun("disable");
      assert.match(String(await disabledRun("status")), /"enabled":false/);
    } finally { await disabled.stop(); }
  } finally { await host.stop(); await h.stop(0); await rm(home, { recursive: true, force: true }); }
});

test("real command routing enforces admin access and refuses switching during an active turn", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-live-admin-"));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const runtime = new FakeRuntime(), h = new Harness({ runtime, tickMs: 60000 });
  const channel = new MemoryChannel(), host = new PluginHost(); h.addChannel(channel);
  host.memoryOrchestration.register("default", { recall: async () => "baseline", capture: async () => {} });
  host.memoryOrchestration.select("default");
  let release: (() => void) | undefined;
  try {
    await host.load([], { home, cwd: home, agent: "test" }, [], [], [memoryOrchestrationPlugin(host.memoryOrchestration, settings, h, true)]);
    installCommands({ harness: h, approvals: { mode: "off", tools: [] }, skills: () => [], reloadSkills: async () => {},
      personality: { current: undefined, available: async () => [], set: async () => {} },
      admins: ["owner"], agent: "test", restart: async () => {}, pluginCommands: host.commands });
    await h.submit(msg("/memory-orchestration disable", "other")); await h.drained();
    assert.match(channel.texts().at(-1)!, /admin only/);
    assert.equal(host.memoryOrchestration.active, "default");
    assert.equal(runtime.sessions.size, 0);
    const session = await h.sessionFor("mem:room1");
    release = runtime.sessions.get("mem:room1")!.hold();
    const turn = h.submit(msg("working", "owner"));
    while (!session.busy) await new Promise(r => setTimeout(r, 1));
    const before = channel.texts().length;
    await h.submit(msg("/memory-orchestration disable", "owner", "mem:admin"));
    for (let i = 0; i < 100 && channel.texts().length === before; i++) await new Promise(r => setTimeout(r, 2));
    assert.match(channel.texts().at(-1)!, /plugin command failed/);
    assert.equal(host.memoryOrchestration.active, "default");
    assert.equal(settings.effective().memory?.orchestration, undefined);
    release(); await turn; await h.drained();
    await h.submit(msg("/memory-orchestration disable", "owner")); await h.drained();
    assert.equal(host.memoryOrchestration.active, "none");
    assert.equal(settings.effective().memory?.orchestration, "none");
  } finally { release?.(); await h.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); }
});
