import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PolicyManager } from "../src/policy-manager.js";
import { policyManagerPlugin } from "../src/builtin-plugins/policy-manager-plugin.js";
import { PluginHost } from "../src/plugins.js";
import { PolicyRegistry } from "../src/policies.js";
import { SettingsService } from "../src/settings.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

async function fixture(t: any, required = false) {
  const home = await mkdtemp(path.join(os.tmpdir(), "policy-manager-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const registry = new PolicyRegistry(required ? ["test"] : []);
  registry.register({ id: "test", assertAllowed: async () => { throw Error("baseline"); } });
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const manager = new PolicyManager(harness, registry, settings, { home, cwd: home, agent: "test" });
  const module = async (body: string) => {
    await writeFile(path.join(home, "module.mjs"), `export default {apiVersion:1, async create(){${body}}}`);
    await settings.setPolicyPlugin("test", { module: "module.mjs" });
    await manager.request("test");
  };
  return { home, settings, registry, harness, manager, module };
}
const good = 'return {policy:{id:"test",async assertAllowed(){}}, async start(){}, async stop(){}}';

test("policy overlays persist, replace, reload, disable and restore captured baseline", async t => {
  const f = await fixture(t);
  await f.module(good); await f.manager.tick();
  await f.registry.assertAllowed("", "publish");
  const reopened = new SettingsService(path.join(f.home, "settings.yaml"), {}); await reopened.load();
  assert.deepEqual(reopened.effective().policyPlugins, { test: { module: "module.mjs" } });
  await f.manager.request("test"); await f.manager.tick();
  await f.settings.setPolicyPlugin("test", { disabled: true }); await f.manager.request("test"); await f.manager.tick();
  assert.equal(f.registry.has("test"), false);
  await f.settings.setPolicyPlugin("test"); await f.manager.request("test"); await f.manager.tick();
  await assert.rejects(f.registry.assertAllowed("", "publish"), /baseline/);
  await f.manager.stop();
});

test("required disable rejected before persistence; required replacement and baseline remain possible", async t => {
  const f = await fixture(t, true);
  assert.throws(() => f.manager.validate("test", { disabled: true }), /Required/);
  assert.equal(f.settings.effective().policyPlugins, undefined);
  await f.module(good); await f.manager.tick(); f.registry.assertReady();
  await f.settings.setPolicyPlugin("test"); await f.manager.request("test"); await f.manager.tick();
  await assert.rejects(f.registry.assertAllowed("", "merge"), /baseline/);
  await f.manager.stop();
});

test("busy turn defers import and retains pending generation", async t => {
  const f = await fixture(t);
  f.harness.addChannel(new MemoryChannel());
  const session = await f.harness.sessionFor("mem:room1");
  const release = (session as any).hold();
  await f.harness.accept(msg("work")); await new Promise(r => setImmediate(r));
  await f.module(good);
  await assert.rejects(f.manager.tick(), /idle turn boundary/);
  assert.deepEqual(JSON.parse(f.manager.status()).pending, ["test"]);
  release(); await f.harness.drained();
  await f.manager.tick(); await f.registry.assertAllowed("", "local"); await f.manager.stop();
});

test("malformed and failed candidates retain previous policy without leaking errors", async t => {
  const f = await fixture(t);
  for (const body of [
    'return {policy:{id:"wrong",async prepare(){}},stop:42}',
    'return {policy:{id:"test",beforeTool:42},async stop(){}}',
    'throw Error("secret-value")',
    'return {policy:{id:"test",async prepare(){}},async start(){throw Error("secret-value")},async stop(){}}',
  ]) {
    await f.module(body); await f.manager.tick();
    await assert.rejects(f.registry.assertAllowed("", "local"), /baseline/);
    assert.match(f.manager.status(), /previous selection retained/);
    assert.doesNotMatch(f.manager.status(), /secret-value/);
  }
  await f.manager.stop();
});

test("old stop failure restarts previous generation; failed restart quarantines hooks", async t => {
  const f = await fixture(t);
  await f.module('let starts=0;return {policy:{id:"test",async assertAllowed(){throw Error("old")}},async start(){if(++starts>2)throw Error("restart")},async stop(){throw Error("stop")}}');
  await f.manager.tick();
  await f.module(good); await f.manager.tick();
  await assert.rejects(f.registry.assertAllowed("", "local"), /old/);
  assert.match(f.manager.status(), /previous selection retained/);
  await f.manager.request("test"); await f.manager.tick();
  assert.deepEqual(JSON.parse(f.manager.status()).degraded, ["test"]);
  await assert.rejects(f.registry.assertAllowed("", "publish"), /restart required/);
  await assert.rejects(f.manager.request("test"), /restart required/);
  await assert.rejects(f.manager.stop(), /cleanup failed/);
});

test("failed candidate cleanup blocks hooks and keeps resource for shutdown retry", async t => {
  const f = await fixture(t);
  await f.module('let stops=0; return {policy:{id:"test",async prepare(){}},async start(){throw Error("start")},async stop(){if(++stops===1)throw Error("cleanup")}}');
  await f.manager.tick();
  await assert.rejects(f.registry.beforeTool("", "bash", {}), /restart required/);
  assert.deepEqual(JSON.parse(f.manager.status()).degraded, ["test"]);
  await f.manager.stop();
});

test("new request during preparation supersedes candidate and survives pending cleanup", async t => {
  const f = await fixture(t);
  const key = `policyRace${Date.now()}`;
  let release!: () => void;
  (globalThis as any)[key] = { wait: new Promise<void>(r => { release = r; }), entered: false, stops: 0 };
  t.after(() => { delete (globalThis as any)[key]; });
  await f.module(`globalThis.${key}.entered=true;await globalThis.${key}.wait;return {policy:{id:"test",async assertAllowed(){}},async stop(){globalThis.${key}.stops++}}`);
  const first = f.manager.tick();
  while (!(globalThis as any)[key].entered) await new Promise(r => setImmediate(r));
  await f.settings.setPolicyPlugin("test", { disabled: true }); await f.manager.request("test");
  assert.equal(f.manager.tick(), first);
  release(); await first;
  assert.equal((globalThis as any)[key].stops, 1);
  assert.deepEqual(JSON.parse(f.manager.status()).pending, ["test"]);
  await f.manager.tick(); assert.equal(f.registry.has("test"), false);
  await f.manager.stop();
});

test("shutdown serializes preparation and prevents late install", async t => {
  const f = await fixture(t);
  const key = `policyStop${Date.now()}`;
  let release!: () => void;
  (globalThis as any)[key] = { wait: new Promise<void>(r => { release = r; }), entered: false, stops: 0 };
  t.after(() => { delete (globalThis as any)[key]; });
  await f.module(`globalThis.${key}.entered=true;await globalThis.${key}.wait;return {policy:{id:"test",async assertAllowed(){}},async stop(){globalThis.${key}.stops++}}`);
  const tick = f.manager.tick();
  while (!(globalThis as any)[key].entered) await new Promise(r => setImmediate(r));
  const stop = f.manager.stop(); assert.equal(f.manager.stop(), stop);
  await assert.rejects(f.manager.request("test"), /stopping/);
  release(); await tick; await stop;
  assert.equal((globalThis as any)[key].stops, 1);
  await assert.rejects(f.registry.assertAllowed("", "local"), /baseline/);
});

test("admin adapter defaults privileged, validates before write, and queues rather than activating inline", async t => {
  const f = await fixture(t, true);
  const host = new PluginHost();
  await host.load([], { agent: "test", home: f.home, cwd: f.home }, [], [], [policyManagerPlugin(f.manager, f.settings)]);
  const command = host.commands.get("policy-plugin")!;
  assert.equal(command.admin, true);
  await assert.rejects(command.run("disable test", msg("")), /Required/);
  assert.equal(f.settings.effective().policyPlugins, undefined);
  await assert.rejects(command.run("use test", msg("")), /Use status/);
  assert.match(await command.run("use optional module.mjs", msg("")), /pending/);
  assert.equal(f.registry.has("optional"), false);
  assert.deepEqual(JSON.parse(f.manager.status()).pending, ["optional"]);
  await command.run("baseline optional", msg("")); await f.manager.tick();
  assert.equal(f.registry.has("optional"), false);
  assert.match(await command.run("status", msg("")), /active/);
  await f.manager.stop(); await host.stop();
});

test("request during old stop rolls back before activating newer selection", async t => {
  const f = await fixture(t);
  const key = `policyOldStop${Date.now()}`;
  let release!: () => void;
  (globalThis as any)[key] = { wait: new Promise<void>(r => { release = r; }), entered: false, starts: 0 };
  t.after(() => { delete (globalThis as any)[key]; });
  await f.module(`return {policy:{id:"test",async assertAllowed(){throw Error("old")}},async start(){globalThis.${key}.starts++},async stop(){globalThis.${key}.entered=true;await globalThis.${key}.wait}}`);
  await f.manager.tick();
  await f.module(good); const tick = f.manager.tick();
  while (!(globalThis as any)[key].entered) await new Promise(r => setImmediate(r));
  await f.settings.setPolicyPlugin("test", { disabled: true }); await f.manager.request("test");
  release(); await tick;
  await assert.rejects(f.registry.assertAllowed("", "local"), /old/);
  assert.equal((globalThis as any)[key].starts, 2);
  assert.deepEqual(JSON.parse(f.manager.status()).pending, ["test"]);
  await f.manager.tick(); assert.equal(f.registry.has("test"), false); await f.manager.stop();
});

test("initial invalid desired module fails startup", async t => {
  const f = await fixture(t);
  await f.settings.setPolicyPlugin("test", { module: "missing.mjs" });
  await assert.rejects(f.manager.load(), /Initial policy activation failed/);
  await f.manager.stop();
});
