// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExtensionManager } from "../src/extension-manager.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { extensionManagerPlugin } from "../src/builtin-plugins/extension-manager-plugin.js";

async function fixture(t: any) {
  const home = await mkdtemp(path.join(os.tmpdir(), "extension-manager-")); t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const host = new PluginHost(); const manager = new ExtensionManager({ atIdleBoundary: async change => change() }, host, settings, { home, cwd: home, agent: "test" }, ["help"]);
  const module = async (body: string) => { await writeFile(path.join(home, "module.mjs"), `export default {apiVersion:1,async activate(api){${body}}}`); await settings.setExtensionPlugin("example", { module: "module.mjs" }); manager.request("example"); };
  return { home, settings, host, manager, module };
}
test("extension add/replace/remove owns commands panels and optional policies with persistent selection", async t => {
  const f = await fixture(t);
  await f.module(`api.registerCommand({name:'hello',help:'test',async run(){return 'one'}});api.registerPanel({name:'test',render(){return ['one']}});api.registerPolicy({id:'optional',async beforeTool(){}})`);
  await f.manager.tick();
  assert.equal(await f.host.commands.get("hello")!.run("", {} as any), "one");
  assert.ok(f.host.policies.has("optional"));
  const reopened = new SettingsService(path.join(f.home, "settings.yaml"), {}); await reopened.load();
  assert.deepEqual(reopened.effective().extensionPlugins, { example: { module: "module.mjs" } });
  const stale = f.host.commands.get("hello")!;
  await f.module(`api.registerCommand({name:'hello',help:'test',async run(){return 'two'}})`); await f.manager.tick();
  assert.equal(await f.host.commands.get("hello")!.run("", {} as any), "two");
  await assert.rejects(stale.run("", {} as any), /unavailable/);
  assert.equal(f.host.panels.size, 0); assert.equal(f.host.policies.has("optional"), false);
  await f.settings.setExtensionPlugin("example", { disabled: true }); f.manager.request("example"); await f.manager.tick();
  assert.equal(f.host.commands.size, 0); await f.manager.stop(); await f.host.stop();
});
test("in-flight command pins retiring generation until completion while new calls use replacement", async t => {
  const f = await fixture(t); const key = `extension${Date.now()}`; let release!: () => void;
  (globalThis as any)[key] = { wait: new Promise<void>(r => { release = r; }), cleaned: false };
  t.after(() => { delete (globalThis as any)[key]; });
  await f.module(`api.registerCommand({name:'hello',help:'test',async run(){await globalThis.${key}.wait;return 'old'}});api.onStop(()=>{globalThis.${key}.cleaned=true})`); await f.manager.tick();
  const running = f.host.commands.get("hello")!.run("", {} as any);
  await f.module(`api.registerCommand({name:'hello',help:'test',async run(){return 'new'}})`); await f.manager.tick();
  assert.equal((globalThis as any)[key].cleaned, false);
  assert.equal(await f.host.commands.get("hello")!.run("", {} as any), "new");
  release(); assert.equal(await running, "old"); await f.manager.stop();
  assert.equal((globalThis as any)[key].cleaned, true);
});
test("actual Harness busy turn defers extension import and admin command is privileged", async t => {
  const f = await fixture(t);
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); harness.addChannel(new MemoryChannel());
  const manager = new ExtensionManager(harness, f.host, f.settings, { home: f.home, cwd: f.home, agent: "test" }, ["help"]);
  await f.host.load([], { home: f.home, cwd: f.home, agent: "test" }, [], [], [extensionManagerPlugin(manager, f.settings)]);
  const command = f.host.commands.get("extension-plugin")!; assert.equal(command.admin, true);
  await writeFile(path.join(f.home, "module.mjs"), "export default {apiVersion:1,activate(api){api.registerCommand({name:'hello',help:'test',async run(){return 'ok'}})}}");
  const session = await harness.sessionFor("mem:room1"); const release = (session as any).hold();
  await harness.accept(msg("work")); await new Promise(r => setImmediate(r));
  await command.run("use example module.mjs", {} as any);
  await assert.rejects(manager.tick(), /idle turn boundary/); assert.equal(f.host.commands.has("hello"), false);
  release(); await harness.drained(); await manager.tick(); assert.ok(f.host.commands.has("hello"));
  await manager.stop(); await harness.stop(0); await f.host.stop();
});
test("cleanup failure blocks activation honestly and stop reports failure", async t => {
  const f = await fixture(t);
  await f.module("api.onStop(()=>{throw Error('secret')}); throw Error('candidate')");
  await f.manager.tick(); assert.equal(JSON.parse(f.manager.status()).degraded, true);
  assert.throws(() => f.manager.request("example")); assert.doesNotMatch(f.manager.status(), /secret/);
  await assert.rejects(f.manager.stop(), /cleanup failed/);
});
test("external policy ownership changes are preserved and replacement rejected", async t => {
  const f = await fixture(t);
  await f.module("api.registerPolicy({id:'optional',async beforeTool(){}})"); await f.manager.tick();
  f.host.policies.replace({ id: "optional", async beforeTool() { throw Error("external"); } });
  await f.module("api.registerCommand({name:'hello',help:'test',async run(){return 'candidate'}})"); await f.manager.tick();
  assert.equal(f.host.commands.has("hello"), false);
  await assert.rejects(f.host.policies.beforeTool("", "bash", {}), /external/); await f.manager.stop();
  assert.ok(f.host.policies.has("optional"));
});
test("superseded asynchronous activation cannot publish late candidates", async t => {
  const f = await fixture(t); const key = `extensionRace${Date.now()}`; let release!: () => void;
  (globalThis as any)[key] = { wait: new Promise<void>(r => { release = r; }), entered: false, cleaned: 0 };
  t.after(() => { delete (globalThis as any)[key]; });
  await f.module(`globalThis.${key}.entered=true;await globalThis.${key}.wait;api.registerCommand({name:'hello',help:'test',async run(){return 'late'}});api.onStop(()=>{globalThis.${key}.cleaned++})`);
  const tick = f.manager.tick(); while (!(globalThis as any)[key].entered) await new Promise(r => setImmediate(r));
  await f.settings.setExtensionPlugin("example", { disabled: true }); f.manager.request("example"); release(); await tick;
  assert.equal(f.host.commands.has("hello"), false); assert.deepEqual(JSON.parse(f.manager.status()).pending, ["example"]);
  await f.manager.tick(); assert.equal((globalThis as any)[key].cleaned, 1); await f.manager.stop();
});

test("failed publication rolls back old commands and policy generation", async t => {
  const f = await fixture(t);
  await f.module("api.registerCommand({name:'hello',help:'test',async run(){return 'old'}});api.registerPolicy({id:'optional',async beforeTool(){}})"); await f.manager.tick();
  const register = f.host.policies.register.bind(f.host.policies); let fail = true;
  f.host.policies.register = policy => { if (fail) { fail = false; throw Error('publication failure'); } return register(policy); };
  await f.module("api.registerCommand({name:'hello',help:'test',async run(){return 'new'}});api.registerPolicy({id:'optional',async beforeTool(){}})"); await f.manager.tick();
  assert.equal(await f.host.commands.get('hello')!.run('', {} as any), 'old');
  assert.ok(f.host.policies.has('optional')); assert.match(f.manager.status(), /previous selection retained/);
  await f.manager.stop(); assert.equal(f.host.policies.has('optional'), false);
});

test("stop serializes in-flight preparation and pins cleanup completion", async t => {
  const f = await fixture(t); const key = `extensionStop${Date.now()}`; let release!: () => void;
  (globalThis as any)[key] = { wait: new Promise<void>(r => { release = r; }), entered: false, cleaned: 0 };
  t.after(() => { delete (globalThis as any)[key]; });
  await f.module(`globalThis.${key}.entered=true;await globalThis.${key}.wait;api.registerCommand({name:'hello',help:'test',async run(){return 'late'}});api.onStop(()=>{globalThis.${key}.cleaned++})`);
  const tick = f.manager.tick(); while (!(globalThis as any)[key].entered) await new Promise(r => setImmediate(r));
  const stop = f.manager.stop(); assert.equal(f.manager.stop(), stop); release(); await tick; await stop;
  assert.equal(f.host.commands.has("hello"), false); assert.equal((globalThis as any)[key].cleaned, 1);
});

test("unsupported services and builtin conflicts preserve prior generation", async t => {
  const f = await fixture(t);
  await f.module(`api.registerCommand({name:'hello',help:'test',async run(){return 'old'}})`); await f.manager.tick();
  for (const code of [`api.registerCommand({name:'help',help:'conflict',async run(){return ''}})`, `api.registerMemoryOrchestrator('test',{async recall(){return ''},async capture(){}})`]) {
    await f.module(code); await f.manager.tick();
    assert.equal(await f.host.commands.get("hello")!.run("", {} as any), "old"); assert.match(f.manager.status(), /failed/);
  }
  await f.manager.stop();
});
