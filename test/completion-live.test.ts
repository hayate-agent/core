import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import { PureStrategy } from "../src/pure-strategy.js";
import { completionStrategyPlugin } from "../src/builtin-plugins/completion-strategy-plugin.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { installCommands } from "../src/commands.js";

const validate = (value: unknown) => {
  const module = value as { apiVersion: number; prompt: () => string };
  if (module?.apiVersion !== 1 || typeof module.prompt !== "function") throw Error("Invalid completion strategy");
  return module.prompt.bind(module);
};
test("completion admin selection reloads, disables and restores baseline; busy/save failures retain generation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "completion-live-"));
  const host = new PluginHost(), h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  t.after(async () => { await host.stop(); await h.stop(0); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const holder = new PureStrategy(home, { apiVersion: 1, prompt: () => "baseline" }, validate);
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,label:'custom',prompt(){return this.label}}");
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [completionStrategyPlugin(holder, settings, h)]);
  const command = host.commands.get("completion-strategy")!; assert.equal(command.admin, true);
  const run = (args: string) => command.run(args, {} as any);
  assert.match(String(await run("status")), /baseline/);
  await run("use custom.mjs"); assert.equal(holder.current!(), "custom");
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,prompt(){return 'reloaded'}}");
  await run("reload"); assert.equal(holder.current!(), "reloaded");
  await assert.rejects(run("use missing.mjs")); assert.equal(holder.current!(), "reloaded");
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const reservation = h.atIdleBoundary(() => gate);
  try { await assert.rejects(run("disable"), /idle turn boundary/); } finally { release(); await reservation; }
  const save = settings.setCompletionStrategy.bind(settings);
  settings.setCompletionStrategy = async () => { throw Error("disk offline"); };
  await assert.rejects(run("disable"), /disk offline/); assert.equal(holder.current!(), "reloaded");
  settings.setCompletionStrategy = save;
  await run("disable"); assert.equal(holder.current, undefined); assert.equal(settings.snapshot().completionStrategy, null);
  await run("baseline"); assert.equal(holder.current!(), "baseline"); assert.equal(settings.snapshot().completionStrategy, undefined);
});

test("real routing refuses nonadmin selection without loading code", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "completion-admin-"));
  const runtime = new FakeRuntime(), h = new Harness({ runtime, tickMs: 60000 }), host = new PluginHost();
  const channel = new MemoryChannel(); h.addChannel(channel);
  t.after(async () => { await h.stop(1000); await host.stop(); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const holder = new PureStrategy(home, { apiVersion: 1, prompt: () => "baseline" }, validate);
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [completionStrategyPlugin(holder, settings, h)]);
  installCommands({ harness: h, approvals: { mode: "off", tools: [] }, skills: () => [], reloadSkills: async () => {},
    personality: { current: undefined, available: async () => [], set: async () => {} },
    admins: ["owner"], agent: "test", restart: async () => {}, pluginCommands: host.commands });
  await h.submit(msg("/completion-strategy use missing.mjs", "other")); await h.drained();
  assert.match(channel.texts().at(-1)!, /admin only/); assert.equal(runtime.opened.length, 0);
  assert.equal(holder.current!(), "baseline");
  await h.submit(msg("/completion-strategy disable", "owner")); await h.drained();
  assert.equal(holder.current, undefined);
});
