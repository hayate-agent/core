import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { GatewayManager } from "../src/gateway-manager.js";
import { SettingsService } from "../src/settings.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

test("gateway plugin override activation, disable, baseline and failed-start rollback", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-manager-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const module = (label: string, fails = false) => `export default {apiVersion:1,async create(){return {channel:{name:'test',label:'${label}',async start(){${fails ? "throw Error('start failed')" : ""}},async stop(){},async send(){}}}}}`;
  await writeFile(path.join(home, "baseline.mjs"), module("base"));
  await writeFile(path.join(home, "custom.mjs"), module("custom"));
  await writeFile(path.join(home, "broken.mjs"), module("broken", true));
  const settings = new SettingsService(path.join(home, "settings.local.yaml"), {}); await settings.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, { test: path.join(home, "baseline.mjs") });
  await manager.load();
  let command: any;
  await manager.plugin().activate({ registerCommand: (c: any) => { command = c; } } as any, {} as any);
  assert.equal(await command.run(""), manager.status());
  assert.equal((harness.channels.get("test") as any).label, "base");
  await settings.setGatewayPlugin("test", { module: "custom.mjs" });
  await manager.request("test"); await manager.tick();
  assert.equal((harness.channels.get("test") as any).label, "custom");
  await settings.setGatewayPlugin("test", { module: "broken.mjs" });
  await manager.request("test"); await manager.tick();
  assert.equal((harness.channels.get("test") as any).label, "custom");
  assert.match(manager.status(), /Activation failed/);
  await settings.setGatewayPlugin("test", { disabled: true });
  await manager.request("test"); await manager.tick();
  assert.equal(harness.channels.has("test"), false);
  await settings.setGatewayPlugin("test", undefined);
  await manager.request("test"); await manager.tick();
  assert.equal((harness.channels.get("test") as any).label, "base");
  const restored = new SettingsService(settings.file, {}); await restored.load();
  assert.deepEqual(restored.effective().gatewayPlugins, {});
});

test("runtime activation adopts missing home without overwriting an explicit destination", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "gateway.mjs"), `export default {apiVersion:1,async create(){return {home:{channel:'test',target:'room'},channel:{name:'test',async start(){},async stop(){},async send(){}}}}}`);
  for (const explicit of [false, true]) {
    const settings = new SettingsService(path.join(home, `settings-${explicit}.yaml`), {}); await settings.load();
    await settings.setGatewayPlugin("test", { disabled: true });
    const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
    if (explicit) harness.home = { channel: "other", target: "operator" };
    const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, { test: path.join(home, "gateway.mjs") });
    await manager.load();
    await settings.setGatewayPlugin("test", undefined); await manager.request("test"); await manager.tick();
    assert.deepEqual(harness.home, explicit ? { channel: "other", target: "operator" } : { channel: "test", target: "room" });
  }
});

test("replacement is refused during an active turn", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000 });
  harness.addChannel(new MemoryChannel());
  const session = await harness.sessionFor("mem:room1");
  const release = (session as any).hold();
  await harness.accept(msg("work"));
  await new Promise((r) => setImmediate(r));
  await assert.rejects(harness.replaceGateway("test"), /idle turn boundary/);
  release(); await harness.drained();
});
