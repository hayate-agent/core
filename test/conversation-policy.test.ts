import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gatewaySettings, validateGatewayConfig, validateConversationPolicy, applyGatewaySettings } from "../src/gateway-settings.js";
import { SettingsService } from "../src/settings.js";
import { conversationPolicyPlugin } from "../src/conversation-policy-plugin.js";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { FakeRuntime } from "./fakes.js";

test("conversation defaults and access are strictly typed; unsupported adapters fail closed", () => {
  const policy = { allowedChannels: "*" as const, defaults: { users: "*" as const, activation: "threads" as const }, channels: { C1: { activation: "open" as const } } };
  validateGatewayConfig({ overrides: { slack: { conversation: policy } } });
  assert.deepEqual(gatewaySettings({ overrides: { slack: { conversation: policy } } }, "slack").conversation, policy);
  assert.equal(gatewaySettings({ overrides: { slack: { conversation: policy } } }, "matrix").conversation, undefined);
  for (const p of [{ defaults: { users: true } }, { allowedChannels: "all" }, { defaults: { activation: "always" } }, { defaults: { admin: true } }])
    assert.throws(() => validateConversationPolicy(p), /Invalid/);
  assert.throws(() => applyGatewaySettings({ name: "old" }, { overrides: { old: { conversation: policy } } }), /does not support/);
});

test("installation/local/drop-in layers preserve independent defaults, channels and deny lists", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-conversation-settings-")); t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "settings.d"));
  await writeFile(path.join(home, "settings.local.yaml"), 'gateways:\n  overrides:\n    slack:\n      conversation:\n        defaults: {users: [U1]}\n        channels:\n          C1: {activation: open}\n');
  await writeFile(path.join(home, "settings.d/90-policy.yaml"), 'gateways:\n  overrides:\n    slack:\n      conversation:\n        defaults: {replyLocation: channel}\n        channels:\n          C2: {users: []}\n');
  const settings = new SettingsService(path.join(home, "settings.local.yaml"), { gateways: { overrides: { slack: { conversation: {
    defaults: { activation: "threads", users: "*" }, allowedChannels: "*" } } } } });
  await settings.load(); assert.deepEqual(settings.diagnostics, []);
  const policy = settings.effective().gateways?.overrides?.slack?.conversation!;
  assert.deepEqual(policy.defaults, { activation: "threads", users: ["U1"], replyLocation: "channel" });
  assert.equal(policy.allowedChannels, "*"); assert.deepEqual(policy.channels, { C1: { activation: "open" }, C2: { users: [] } });
  await settings.setGateways({ overrides: { slack: { conversation: { channels: { C3: { activation: "disabled" } } } } } });
  assert.equal(settings.effective().gateways?.overrides?.slack?.conversation?.channels?.C1?.activation, "open");
  assert.equal(settings.effective().gateways?.overrides?.slack?.conversation?.channels?.C3?.activation, "disabled");
});

test("policy control is admin-only and updating users never grants admin rights", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-conversation-command-"));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); harness.onStateChange = async () => {};
  t.after(async () => { await harness.stop(); await rm(home, { recursive: true, force: true }); });
  let applied: any;
  harness.addChannel({ name: "chat", conversationPolicy: 1, configureGateway: policy => { applied = policy; }, async start() {}, async stop() {}, async send() {} });
  const host = new PluginHost(); await host.load([conversationPolicyPlugin(settings, harness)], { home, cwd: home, agent: "any" }, []);
  const command = host.commands.get("conversation-policy")!;
  assert.equal(command.admin, true);
  await command.run('defaults chat {"users":"*","activation":"threads"}', { sessionKey: "console:local" });
  await command.run('channel chat C1 {"activation":"open","replyLocation":"channel"}', { sessionKey: "console:local" });
  assert.equal(applied.conversation.defaults.users, "*"); assert.equal(applied.conversation.channels.C1.activation, "open");
  assert.equal((settings.effective() as any).admins, undefined);
  await assert.rejects(command.run('defaults chat {"admins":["U1"]}', { sessionKey: "console:local" }), /Invalid/);
});
