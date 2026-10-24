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

test("activation preserves a newer request arriving during replacement on success and failure", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-pending-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const label of ["first", "newer"]) {
    await writeFile(path.join(home, `${label}.mjs`), `export default {apiVersion:1,async create(){return {channel:{name:'test',label:'${label}',async start(){},async stop(){},async send(){}}}}}`);
  }
  for (const fails of [false, true]) {
    const settings = new SettingsService(path.join(home, `settings-${fails}.yaml`), {}); await settings.load();
    const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
    const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, {});
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const replace = harness.replaceGateway.bind(harness);
    let calls = 0;
    harness.replaceGateway = async (name, candidate) => {
      if (++calls === 1) {
        entered(); await gate;
        if (fails) throw Error("first activation failed");
      }
      await replace(name, candidate);
    };
    await settings.setGatewayPlugin("test", { module: "first.mjs" }); await manager.request("test");
    const activation = manager.tick(); await started;
    await settings.setGatewayPlugin("test", { module: "newer.mjs" }); await manager.request("test");
    release(); await activation;
    assert.deepEqual(JSON.parse(manager.status()).pending, ["test"]);
    await manager.tick();
    assert.equal((harness.channels.get("test") as any).label, "newer");
    assert.deepEqual(JSON.parse(manager.status()).pending, []);
    assert.deepEqual(JSON.parse(manager.status()).errors, {});
  }
});

test("slow older preparation cannot overwrite a newer desired gateway", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-order-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, {});
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  let calls = 0;
  (manager as any).prepare = async () => {
    const label = ++calls === 1 ? "old" : "new";
    if (label === "old") { entered(); await gate; }
    return { channel: { name: "test", label, async start() {}, async stop() {}, async send() {} } };
  };
  const older = manager.request("test"); await started;
  await manager.request("test"); release(); await older;
  await manager.tick();
  assert.equal((harness.channels.get("test") as any).label, "new");
  assert.deepEqual(JSON.parse(manager.status()).pending, []);
});

test("failed newer preparation invalidates pending activation and reports a sanitized error", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-prepare-failure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const module = (label: string) => `export default {apiVersion:1,async create(){return {channel:{name:'test',label:'${label}',async start(){},async stop(){},async send(){}}}}}`;
  await writeFile(path.join(home, "base.mjs"), module("base"));
  await writeFile(path.join(home, "older.mjs"), module("older"));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, { test: "base.mjs" });
  await manager.load();
  await settings.setGatewayPlugin("test", { module: "older.mjs" });
  await manager.request("test");
  await settings.setGatewayPlugin("test", { module: "private-missing-path.mjs" });
  await assert.rejects(manager.request("test"));
  await manager.tick();
  assert.equal((harness.channels.get("test") as any).label, "base");
  const status = JSON.parse(manager.status());
  assert.deepEqual(status.pending, []);
  assert.match(status.errors.test, /Preparation failed/);
  assert.ok(!manager.status().includes("private-missing-path"));
  await settings.setGatewayPlugin("test", undefined);
  await manager.request("test"); await manager.tick();
  assert.deepEqual(JSON.parse(manager.status()).errors, {});
});

test("new preparation invalidates pending immediately and stale failures do not replace current status", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-pending-order-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, {});
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  (manager as any).prepare = async () => {
    const call = ++calls;
    if (call === 2) { await gate; throw Error("private stale failure"); }
    return { channel: { name: "test", label: call, async start() {}, async stop() {}, async send() {} } };
  };
  await manager.request("test");
  const slow = manager.request("test");
  const rejected = assert.rejects(slow, /private stale failure/);
  await manager.tick();
  assert.equal(harness.channels.has("test"), false);
  await manager.request("test");
  await manager.tick();
  release(); await rejected;
  assert.equal((harness.channels.get("test") as any).label, 3);
  assert.deepEqual(JSON.parse(manager.status()).pending, []);
  assert.deepEqual(JSON.parse(manager.status()).errors, {});
});

test("new preparation failure is not erased by an older activation completion", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-error-order-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const fails of [false, true]) {
    const settings = new SettingsService(path.join(home, `settings-${fails}.yaml`), {}); await settings.load();
    const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
    const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, {});
    let calls = 0;
    (manager as any).prepare = async () => {
      if (++calls === 2) throw Error("private preparation error");
      return undefined;
    };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { entered = r; });
    harness.replaceGateway = async () => {
      entered(); await gate;
      if (fails) throw Error("older activation error");
    };
    await manager.request("test");
    const activation = manager.tick(); await started;
    await assert.rejects(manager.request("test"));
    release(); await activation;
    assert.match(JSON.parse(manager.status()).errors.test, /Preparation failed/);
    assert.deepEqual(JSON.parse(manager.status()).pending, []);
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
