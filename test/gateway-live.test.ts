import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";
import { PluginHost } from "../src/plugins.js";
import { gatewayPlugin } from "../src/gateway-plugin.js";
import { Harness } from "../src/harness.js";

test("gateway command persists and live applies settings, invalid changes have no effect", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-live-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.local.yaml");
  const settings = new SettingsService(file, {}); await settings.load();
  const seen: unknown[] = [];
  const harness = new Harness({ runtime: {} as any, tickMs: 60000 });
  harness.addChannel({ name: "matrix", configureGateway: (s) => { seen.push(s); }, async start() {}, async stop() {}, async send() {} });
  const host = new PluginHost();
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [gatewayPlugin(settings, harness)]);
  t.after(() => host.stop());
  const command = host.commands.get("gateway")!;
  assert.equal(command.admin, true);
  const ctx = { sessionKey: "test" };
  await command.run("progress reduced", ctx);
  await command.run("reactions on", ctx);
  assert.deepEqual(seen.at(-1), { progress: "reduced", statusReactions: true });
  await assert.rejects(command.run("reactions perhaps", ctx));
  const restored = new SettingsService(file, {}); await restored.load();
  assert.equal(restored.effective().gateways?.progress, "reduced");
  assert.equal(restored.effective().gateways?.statusReactions, true);
});

test("partial channel overlays preserve baseline privacy and reaction fields", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "gateway-inheritance-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService(path.join(home, "settings.yaml"), { gateways: { progress: "full", overrides: { matrix: { progress: "off", statusReactions: true } } } });
  await settings.load(); await settings.setGateways({ overrides: { matrix: { statusReactions: false } } });
  assert.deepEqual(settings.effective().gateways?.overrides?.matrix, { progress: "off", statusReactions: false });
});

test("memory embedding settings persist without secret values and reject invalid overlays", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.local.yaml");
  const settings = new SettingsService(file, {}); await settings.load();
  await settings.setMemory({ embedding: { url: "https://embedding.example/v1/embeddings", model: "embedding-model", dimensions: 768, tokenEnv: "MODEL_API_KEY" } });
  await settings.setGateways({ progress: "reduced", statusReactions: true });
  const restored = new SettingsService(file, {}); await restored.load();
  assert.equal(restored.effective().memory?.embedding?.dimensions, 768);
  assert.equal(restored.effective().gateways?.progress, "reduced");
  await assert.rejects(settings.setMemory({ embedding: { url: "file:///secret", model: "bad" } }));
  await assert.rejects(settings.setMemory({ secret: "not-allowed" } as any));
});

test("gateway replacement excludes pending sends and delivery retries during activation", async () => {
  const harness = new Harness({ runtime: {} as any, tickMs: 60000 });
  let releaseSend!: () => void, releaseStop!: () => void;
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
  let stopped = false, sent = 0;
  harness.addChannel({ name: "mem", async start() {}, async stop() { stopped = true; await stopGate; }, async send() { await sendGate; } });
  const to = { channel: "mem", target: "room" };
  const sending = harness.deliver(to, "old reply");
  await assert.rejects(harness.replaceGateway("mem"), /idle turn boundary/);
  assert.equal(stopped, false);
  releaseSend(); await sending;
  const replacement = harness.replaceGateway("mem", { name: "mem", async start() {}, async stop() {}, async send() { sent++; } });
  assert.equal(stopped, true);
  await assert.rejects(harness.deliver(to, "retry me"), /retry delivery/);
  releaseStop(); await replacement;
  await harness.deliver(to, "retry me");
  assert.equal(sent, 1);
});

test("receipt is emitted after durable acceptance even while work is paused; duplicates do not repeat", async () => {
  const events: string[] = [];
  const harness = new Harness({ runtime: {} as any, tickMs: 60000 }); harness.paused = true;
  harness.onStateChange = async () => { events.push("save"); };
  harness.addChannel({ name: "mem", async start() {}, async stop() {}, async send() {}, async received() { events.push("received"); } });
  const input = { id: "event1", sessionKey: "mem:room", text: "work", source: "channel" as const, replyTo: { channel: "mem", target: "room" } };
  await harness.accept(input);
  assert.ok(events.indexOf("save") < events.indexOf("received"));
  await harness.accept(input);
  assert.equal(events.filter((x) => x === "received").length, 1);
});
