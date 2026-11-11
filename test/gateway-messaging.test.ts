import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { SettingsService } from "../src/settings.js";
import { GatewayManager } from "../src/gateway-manager.js";
import { PluginHost } from "../src/plugins.js";
import { messagePlugin } from "../src/message-plugin.js";
import { FakeRuntime } from "./fakes.js";

const gateway = (output: string) => `import {writeFile} from 'node:fs/promises';
export default {apiVersion:1,updateAdmission:'foreground-owned',async create(){let live=false;
return {channel:{name:'chat',messaging:{describe:()=>({text:true,connected:live,destinationFormat:'exact room ID'}),
async destinations(){return {destinations:[{target:'room1',name:'Room'}]}}},
async start(){live=true},async stop(){live=false},async send(to,text,meta){await writeFile(${JSON.stringify(output)},JSON.stringify({to,text,meta}))}}}}};`;

test("generic live gateway discovery and receipt-backed delivery use the real host, including removal fencing", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-gateway-message-"));
  const settings = new SettingsService(path.join(home, "settings.local.yaml"), {}); await settings.load();
  const output = path.join(home, "sent.json"); await writeFile(path.join(home, "chat.mjs"), gateway(output));
  await settings.setGatewayPlugin("chat", { module: "chat.mjs" });
  let manager: GatewayManager;
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, updateBlockers: () => manager.updateBlockers() });
  harness.onStateChange = async () => {};
  t.after(async () => { await harness.stop(); await rm(home, { recursive: true, force: true }); });
  manager = new GatewayManager(harness, settings, { home, agent: "any-agent", approvers: [] }, {});
  assert.deepEqual(manager.messagingCapabilities(), []);
  await manager.load();
  assert.equal(manager.messagingCapabilities()[0].messaging?.connected, false);
  await harness.start();
  const plugins = new PluginHost(); await plugins.load([messagePlugin(home, manager)], { home, cwd: home, agent: "any-agent" }, []);
  const tool = plugins.tools.get("plugin_message")!;
  assert.equal(manager.messagingCapabilities()[0].messaging?.connected, true);
  assert.deepEqual(await manager.destinations("chat", 50), { destinations: [{ target: "room1", name: "Room" }] });
  const receipt = JSON.parse(await tool.execute({ action: "send", gateway: "chat", target: "room1", text: "authorized", requestId: "task1" }, { sessionKey: "main" }));
  assert.equal(receipt.status, "delivered");
  const sent = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(sent.to, { channel: "chat", target: "room1" }); assert.equal(sent.text, "authorized");
  assert.match(sent.meta.deliveryId, /^message:/);
  await settings.setGatewayPlugin("chat", { disabled: true }); await manager.request("chat"); await manager.tick();
  assert.deepEqual(manager.messagingCapabilities(), []);
  await assert.rejects(manager.sendMessage("main", "task2", { channel: "chat", target: "room1" }, "no"), /unavailable/);
  await assert.rejects(manager.destinations("chat", 50), /unavailable/);
});

test("directory and send operations reserve update admission and do not permit unsafe gateway replacement", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-gateway-fence-"));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  await writeFile(path.join(home, "chat.mjs"), gateway(path.join(home, "sent.json")));
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); harness.onStateChange = async () => {};
  t.after(async () => { await harness.stop(); await rm(home, { recursive: true, force: true }); });
  const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, { chat: "chat.mjs" });
  await manager.load(); await harness.start();
  const channel = harness.channels.get("chat")!;
  let release!: () => void; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  channel.send = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); };
  const sending = manager.sendMessage("main", "task", { channel: "chat", target: "room" }, "authorized");
  await started;
  assert.equal(harness.updateAdmissionStatus().status, "busy");
  await assert.rejects(harness.replaceGateway("chat"), /idle turn boundary/);
  release(); await sending;
  const admission = harness.acquireUpdateAdmission(30000); assert.equal(admission.status, "admitted");
  await assert.rejects(manager.sendMessage("main", "later", { channel: "chat", target: "room" }, "no"), /admission|update|fenced/i);
});
