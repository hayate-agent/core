import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import { nightlyStrategyHolder } from "../src/nightly-strategy.js";
import bundled from "../src/builtin-plugins/nightly-default.js";
import { ImprovementController } from "../src/improvement.js";
import { nightlyStrategyPlugin } from "../src/builtin-plugins/nightly-strategy-plugin.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { installCommands } from "../src/commands.js";

test("nightly admin selection reloads, disables and restores baseline; busy/save failures retain generation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-live-"));
  const host = new PluginHost(), h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  t.after(async () => { await host.stop(); await h.stop(0); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const holder = await nightlyStrategyHolder(home, undefined, bundled);
  const controller = new ImprovementController(home, h, "UTC", Date.now, bundled);
  await controller.initializeStrategy(holder, undefined);
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,label:'custom',prompt(){return this.label},completed(){},receipts(){return []},unique(r){return r},report(){return this.label}}");
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [nightlyStrategyPlugin(holder, settings, controller)]);
  const command = host.commands.get("nightly-strategy")!; assert.equal(command.admin, true);
  const run = (args: string) => command.run(args, {} as any);
  assert.match(String(await run("status")), /baseline/);
  await run("use custom.mjs"); assert.equal(holder.current!.prompt({} as any, 1), "custom");
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,prompt(){return 'reloaded'},completed(){},receipts(){return []},unique(r){return r},report(){return 'reloaded'}}");
  await run("reload"); assert.equal(holder.current!.prompt({} as any, 1), "reloaded");
  await assert.rejects(run("use missing.mjs")); assert.equal(holder.current!.prompt({} as any, 1), "reloaded");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const reservation = h.atIdleBoundary(() => gate);
  try { await assert.rejects(run("disable"), /idle turn boundary/); } finally { release(); await reservation; }
  const save = settings.setNightlyStrategy.bind(settings);
  settings.setNightlyStrategy = async () => { throw Error("disk offline"); };
  await assert.rejects(run("disable"), /disk offline/); assert.equal(holder.current!.prompt({} as any, 1), "reloaded");
  settings.setNightlyStrategy = save;
  await run("disable"); assert.equal(holder.current, undefined); assert.equal(settings.snapshot().nightlyStrategy, null);
  await run("baseline"); assert.equal(holder.current!.apiVersion, 1); assert.equal(settings.snapshot().nightlyStrategy, undefined);
});

test("admin plugin cannot disable or replace an unfinished night", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-unreported-"));
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }), host = new PluginHost();
  t.after(async () => { await h.stop(0); await host.stop(); await rm(home, { recursive: true, force: true }); });
  await mkdir(path.join(home, "improvement"));
  await writeFile(path.join(home, "improvement/state.json"), JSON.stringify({ version: 1, night: "2026-10-26", turns: 1, results: ["retained"] }));
  const holder = await nightlyStrategyHolder(home, undefined, bundled);
  const controller = new ImprovementController(home, h, "UTC", Date.now, bundled);
  await controller.initializeStrategy(holder, undefined);
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [nightlyStrategyPlugin(holder, settings, controller)]);
  for (const action of ["disable", "use missing.mjs", "reload", "baseline"]) {
    await assert.rejects(host.commands.get("nightly-strategy")!.run(action, {} as any), /Unreported or pending/);
  }
  assert.equal(holder.selection, undefined);
  assert.equal(holder.current!.apiVersion, 1);
  assert.equal(settings.snapshot().nightlyStrategy, undefined);
});

test("real routing refuses nonadmin selection without loading code", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-admin-"));
  const runtime = new FakeRuntime(), h = new Harness({ runtime, tickMs: 60000 }), host = new PluginHost();
  const channel = new MemoryChannel(); h.addChannel(channel);
  t.after(async () => { await h.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const holder = await nightlyStrategyHolder(home, undefined, bundled);
  const controller = new ImprovementController(home, h, "UTC", Date.now, bundled);
  await controller.initializeStrategy(holder, undefined);
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [nightlyStrategyPlugin(holder, settings, controller)]);
  installCommands({ harness: h, approvals: { mode: "off", tools: [] }, skills: () => [], reloadSkills: async () => {},
    personality: { current: undefined, available: async () => [], set: async () => {} },
    admins: ["owner"], agent: "test", restart: async () => {}, pluginCommands: host.commands });
  await h.submit(msg("/nightly-strategy use missing.mjs", "other")); await h.drained();
  assert.match(channel.texts().at(-1)!, /admin only/); assert.equal(runtime.opened.length, 0);
  assert.equal(holder.current!.apiVersion, 1);
  await h.submit(msg("/nightly-strategy disable", "owner")); await h.drained();
  assert.equal(holder.current, undefined);
});
