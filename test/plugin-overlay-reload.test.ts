import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";
import { pluginOverlayReload } from "../src/plugin-overlay-reload.js";
import { PolicyManager } from "../src/policy-manager.js";
import { ExtensionManager } from "../src/extension-manager.js";
import { GatewayManager } from "../src/gateway-manager.js";
import { PluginHost } from "../src/plugins.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

async function fixture(t: any, required = false) {
  const home = await mkdtemp(path.join(os.tmpdir(), "plugin-overlay-live-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "settings.d"));
  const settings = new SettingsService(path.join(home, "settings.local.yaml"), {});
  await settings.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const host = new PluginHost(required ? ["test"] : []);
  host.policies.register({ id: "test", assertAllowed: async () => { throw Error("baseline"); } });
  const policy = new PolicyManager(harness, host.policies, settings, { home, cwd: home, agent: "test" });
  const extension = new ExtensionManager(harness, host, settings, { home, cwd: home, agent: "test" }, []);
  const gateway = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, {});
  settings.onPluginReload(pluginOverlayReload(settings, { gateway, policy, extension }));
  const file = path.join(home, "settings.d/10-plugins.yaml");
  await writeFile(path.join(home, "policy.mjs"), 'export default {apiVersion:1,create(){return {policy:{id:"test",async assertAllowed(){}},async stop(){}}}}');
  await writeFile(path.join(home, "extension.mjs"), 'export default {apiVersion:1,activate(api){api.registerCommand({name:"extra",help:"test",async run(){return "live"}})}}');
  await writeFile(path.join(home, "gateway.mjs"), 'export default {apiVersion:1,create(){return {channel:{name:"wire",async start(){},async stop(){},async send(){}}}}}');
  t.after(async () => { await extension.stop(); await policy.stop(); });
  const tick = async () => { await policy.tick(); await extension.tick(); await gateway.tick(); };
  return { home, settings, harness, host, policy, extension, gateway, file, tick };
}

test("file add/edit/delete applies all plugin managers at idle, never publishes pending modules", async t => {
  const f = await fixture(t);
  await writeFile(f.file, 'policyPlugins:\n  test: {module: policy.mjs}\nextensionPlugins:\n  extra: {module: extension.mjs}\ngatewayPlugins:\n  wire: {module: gateway.mjs}\n');
  await Promise.all([f.settings.reload(), f.settings.reload()]);
  assert.equal(f.settings.effective().policyPlugins, undefined);
  assert.equal(f.host.commands.has("extra"), false);
  f.harness.stopping = true;
  await assert.rejects(f.policy.tick(), /idle/);
  assert.equal(f.settings.effective().policyPlugins, undefined);
  f.harness.stopping = false;
  await f.tick();
  await f.host.policies.assertAllowed("", "test");
  assert.equal(await f.host.commands.get("extra")!.run(""), "live");
  assert.deepEqual(JSON.parse(f.gateway.status()).active, ["wire"]);
  assert.deepEqual(f.settings.restartPending, []);
  await f.settings.reload();
  assert.deepEqual(JSON.parse(f.policy.status()).pending, []);
  await writeFile(f.file, 'policyPlugins:\n  test: {disabled: true}\nextensionPlugins:\n  extra: {disabled: true}\ngatewayPlugins:\n  wire: {disabled: true}\n');
  await f.settings.reload(); await f.tick();
  assert.equal(f.host.policies.has("test"), false);
  assert.equal(f.host.commands.has("extra"), false);
  await rm(f.file); await f.settings.reload(); await f.tick();
  await assert.rejects(f.host.policies.assertAllowed("", "test"), /baseline/);
  assert.deepEqual(JSON.parse(f.gateway.status()).active, []);
});

test("invalid transaction retains last good; required disable and failed module stay desired, without hot retry", async t => {
  const f = await fixture(t, true);
  await writeFile(f.file, 'policyPlugins:\n  test: {module: policy.mjs}\n');
  await f.settings.reload(); await f.tick();
  const active = f.settings.effective().policyPlugins;
  await writeFile(f.file, 'policyPlugins: [invalid]');
  await assert.rejects(f.settings.reload());
  assert.deepEqual(f.settings.effective().policyPlugins, active);
  await writeFile(f.file, 'policyPlugins:\n  test: {disabled: true}\n');
  await f.settings.reload(); await f.tick();
  assert.deepEqual(f.settings.effective().policyPlugins, active);
  assert.match(f.policy.status(), /Invalid desired/);
  await writeFile(f.file, 'policyPlugins:\n  test: {module: missing.mjs}\n');
  await f.settings.reload(); await f.tick();
  assert.deepEqual(f.settings.effective().policyPlugins, active);
  assert.equal(f.settings.desired().policyPlugins?.test.module, "missing.mjs");
  await f.settings.reload();
  assert.deepEqual(JSON.parse(f.policy.status()).pending, []);
  await writeFile(f.file, 'policyPlugins:\n  test: {module: policy.mjs}\n');
  await f.settings.reload(); await f.tick();
  assert.deepEqual(JSON.parse(f.policy.status()).errors, {});
});

test("explicit successful activation is not imported again on settings reload", async t => {
  const f = await fixture(t);
  await f.settings.setPolicyPlugin("test", { module: "policy.mjs" });
  await f.policy.request("test"); await f.policy.tick();
  await f.settings.reload();
  assert.deepEqual(JSON.parse(f.policy.status()).pending, []);
});

test("module and disabled fields merge across files and deleting a field restores inherited module", async t => {
  const f = await fixture(t);
  await writeFile(f.file, 'policyPlugins:\n  test: {module: policy.mjs}\n');
  const later = path.join(f.home, "settings.d/20-disabled.yaml");
  await writeFile(later, 'policyPlugins:\n  test: {disabled: true}\n');
  await f.settings.reload(); await f.tick();
  assert.equal(f.host.policies.has("test"), false);
  assert.deepEqual(f.settings.effective().policyPlugins?.test, { module: "policy.mjs", disabled: true });
  await rm(later); await f.settings.reload(); await f.tick();
  await f.host.policies.assertAllowed("", "test");
});


test("unrelated legacy settings write cannot publish a failed plugin selection", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "plugin-overlay-legacy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService(path.join(home, "settings.local.yaml"), {});
  await settings.load();
  await settings.setExtensionPlugin("extra", { module: "missing.mjs" });
  assert.equal(settings.effective().extensionPlugins, undefined);
  await settings.set("thinking", "high");
  assert.equal(settings.effective().extensionPlugins, undefined);
  assert.deepEqual(settings.desired().extensionPlugins, { extra: { module: "missing.mjs" } });
  assert.equal(settings.effective().thinking, "high");
  assert.deepEqual(settings.restartPending, ["extensionPlugins"]);
});
