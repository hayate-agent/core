import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import { contextStrategyHolder } from "../src/context-strategies.js";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";
import { contextStrategyPlugin } from "../src/builtin-plugins/context-strategy-plugin.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { installCommands } from "../src/commands.js";

const baseline = { apiVersion: 1 as const, create: () => ({ assess: async () => "keep" as const, project: (m: any[]) => m }) };
const backend = { backend: { review: async () => "{}" }, model: () => undefined };
const evidence = { phase: "before" as const, incoming: "", recent: "", pressureSinceCompaction: false };
test("context admin selection reloads, disables and restores baseline; busy/save failures retain generation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-live-"));
  const host = new PluginHost(), h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  t.after(async () => { await host.stop(); await h.stop(0); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const holder = await contextStrategyHolder(home, undefined, baseline, backend, undefined);
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,async create(){return {label:'handover',assess(){return this.label},project(m){return m}}}}");
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [contextStrategyPlugin(holder, settings, h, maintenance)]);
  const command = host.commands.get("context-strategy")!; assert.equal(command.admin, true);
  const run = (args: string) => command.run(args, {} as any);
  assert.match(String(await run("status")), /baseline/);
  await run("use custom.mjs"); assert.equal(await holder.current!.assess(evidence), "handover");
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,async create(){return {assess(){return 'compact'},project(m){return m}}}}");
  await run("reload"); assert.equal(await holder.current!.assess(evidence), "compact");
  await assert.rejects(run("use missing.mjs")); assert.equal(await holder.current!.assess(evidence), "compact");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const reservation = h.atIdleBoundary(() => gate);
  try { await assert.rejects(run("disable"), /idle turn boundary/); } finally { release(); await reservation; }
  const save = settings.setContextStrategy.bind(settings);
  settings.setContextStrategy = async () => { throw Error("disk offline"); };
  await assert.rejects(run("disable"), /disk offline/); assert.equal(await holder.current!.assess(evidence), "compact");
  settings.setContextStrategy = save;
  await run("disable"); assert.equal(holder.current, undefined); assert.equal(settings.snapshot().contextStrategy, null);
  await run("baseline"); assert.equal(await holder.current!.assess(evidence), "keep"); assert.equal(settings.snapshot().contextStrategy, undefined);
});

for (const mode of ["working turn", "idle maintenance"] as const) test(`admin switch rejects held ${mode} without cancelling owner work`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-held-"));
  const runtime = new FakeRuntime(), host = new PluginHost();
  const holder = await contextStrategyHolder(home, undefined, baseline, backend, undefined);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy, async () => {
    entered(); await gate; return "keep";
  });
  const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: maintenance });
  h.addChannel(new MemoryChannel());
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [contextStrategyPlugin(holder, settings, h, maintenance)]);
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
    await assert.rejects(host.commands.get("context-strategy")!.run("disable", {} as any), /idle turn boundary/);
    assert.ok(holder.current); assert.equal(settings.snapshot().contextStrategy, undefined);
    assert.equal(runtime.sessions.get("mem:room1")!.aborted, 0);
  } finally { release(); await work; await h.drained(); await h.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); }
});

test("real routing refuses nonadmin selection without loading code", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-admin-"));
  const runtime = new FakeRuntime(), h = new Harness({ runtime, tickMs: 60000 }), host = new PluginHost();
  const channel = new MemoryChannel(); h.addChannel(channel);
  t.after(async () => { await h.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const holder = await contextStrategyHolder(home, undefined, baseline, backend, undefined);
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [contextStrategyPlugin(holder, settings, h, maintenance)]);
  installCommands({ harness: h, approvals: { mode: "off", tools: [] }, skills: () => [], reloadSkills: async () => {},
    personality: { current: undefined, available: async () => [], set: async () => {} },
    admins: ["owner"], agent: "test", restart: async () => {}, pluginCommands: host.commands });
  await h.submit(msg("/context-strategy use missing.mjs", "other")); await h.drained();
  assert.match(channel.texts().at(-1)!, /admin only/); assert.equal(runtime.opened.length, 0);
  assert.equal(await holder.current!.assess(evidence), "keep");
  await h.submit(msg("/context-strategy disable", "owner")); await h.drained();
  assert.equal(holder.current, undefined);
});
