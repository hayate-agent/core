import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CompactionSelection } from "../src/compaction.js";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import { compactionStrategyPlugin } from "../src/builtin-plugins/compaction-strategy-plugin.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { installCommands } from "../src/commands.js";

test("compaction admin selection persists validated name, restores baseline and retains selection on busy/save failure", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "compact-live-"));
  const host = new PluginHost(), h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  t.after(async () => { await host.stop(); await h.stop(0); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const selection = new CompactionSelection(new Map([["wrapper", { compact: async () => {} }]]), "native");
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [compactionStrategyPlugin(() => selection, settings, h, maintenance)]);
  const command = host.commands.get("compaction-strategy")!; assert.equal(command.admin, true);
  const run = (text: string) => command.run(text, {} as any);
  assert.match(String(await run("status")), /native/);
  await run("use wrapper"); assert.equal(selection.active, "wrapper"); assert.equal(settings.snapshot().compactionStrategy, "wrapper");
  await assert.rejects(run("use missing"), /Unknown compaction/); assert.equal(selection.active, "wrapper");
  await assert.rejects(run("disable"), /Use status/);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const busy = h.atIdleBoundary(() => gate);
  try { await assert.rejects(run("use native"), /idle turn boundary/); } finally { release(); await busy; }
  const save = settings.setCompactionStrategy.bind(settings);
  settings.setCompactionStrategy = async () => { throw Error("disk offline"); };
  await assert.rejects(run("use native"), /disk offline/); assert.equal(selection.active, "wrapper");
  settings.setCompactionStrategy = save;
  await run("use native"); assert.equal(selection.active, "native");
  await run("use wrapper"); await run("baseline");
  assert.equal(selection.active, "native"); assert.equal(settings.snapshot().compactionStrategy, undefined);
});

for (const mode of ["working turn", "idle maintenance"] as const) test(`admin switch rejects held ${mode} without cancelling owner work`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-held-"));
  const runtime = new FakeRuntime(), host = new PluginHost();
  const selection = new CompactionSelection(new Map(), "native");
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy, async () => {
    entered(); await gate; return "keep";
  });
  const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: maintenance });
  h.addChannel(new MemoryChannel());
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [compactionStrategyPlugin(() => selection, settings, h, maintenance)]);
  const session = await h.sessionFor("mem:room1");
  let work: Promise<unknown> | undefined;
  try {
    if (mode === "working turn") {
      release = runtime.sessions.get("mem:room1")!.hold();
      await h.submit(msg("held work"));
      while (!runtime.sessions.get("mem:room1")!.busy) await new Promise(resolve => setImmediate(resolve));
    } else {
      await maintenance.admit("mem:room1", "held-1", { action: "compact", preserve: "intent", resume: "next" }, 0);
      session.compact = async () => { entered(); await gate; };
      work = h.maintainIdle("mem:room1");
      await Promise.race([started, work.then(() => { throw Error("idle fixture did not enter compaction"); })]);
    }
    await assert.rejects(host.commands.get("compaction-strategy")!.run("use native", {} as any), /idle turn boundary/);
    assert.equal(selection.active, "native"); assert.equal(settings.snapshot().compactionStrategy, undefined);
    assert.equal(runtime.sessions.get("mem:room1")!.aborted, 0);
  } finally { release(); await work; await h.drained(); await h.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); }
});

test("real routing refuses nonadmin selection without loading code", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-admin-"));
  const runtime = new FakeRuntime(), h = new Harness({ runtime, tickMs: 60000 }), host = new PluginHost();
  const channel = new MemoryChannel(); h.addChannel(channel);
  t.after(async () => { await h.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const selection = new CompactionSelection(new Map(), "native");
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [compactionStrategyPlugin(() => selection, settings, h, maintenance)]);
  installCommands({ harness: h, approvals: { mode: "off", tools: [] }, skills: () => [], reloadSkills: async () => {},
    personality: { current: undefined, available: async () => [], set: async () => {} },
    admins: ["owner"], agent: "test", restart: async () => {}, pluginCommands: host.commands });
  await h.submit(msg("/compaction-strategy use missing", "other")); await h.drained();
  assert.match(channel.texts().at(-1)!, /admin only/); assert.equal(runtime.opened.length, 0);
  assert.equal(selection.active, "native");
  await h.submit(msg("/compaction-strategy use native", "owner")); await h.drained();
  assert.equal(selection.active, "native");
});
