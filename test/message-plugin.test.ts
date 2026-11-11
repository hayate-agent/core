import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { messagePlugin } from "../src/message-plugin.js";
import { PluginHost } from "../src/plugins.js";
import { capabilityContext } from "../src/capability-context.js";
import { workflowTools } from "../src/workflow-tools.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-message-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let calls = 0;
  const gateways = { messagingCapabilities: () => [{ gateway: "slack", messaging: {
    text: true, connected: true, destinationFormat: "conversation ID" } }],
    destinations: async () => ({ destinations: [{ target: "C1", name: "channel" }] }),
    sendMessage: async (..._args: unknown[]) => { calls++; } };
  const open = async () => {
    const host = new PluginHost();
    await host.load([messagePlugin(home, gateways)], { home, cwd: home, agent: "test" }, []);
    return host.tools.get("plugin_message")!;
  };
  return { home, gateways, open, get calls() { return calls; } };
}
const send = { action: "send", gateway: "slack", target: "C1", text: "authorized message", requestId: "request-1" };

test("generic messaging is discoverable, explicit nonempty tool selections include it, empty still disables it", async t => {
  const f = await fixture(t), tool = await f.open();
  const info = JSON.parse(await tool.execute({ action: "status" }, { sessionKey: "main" }));
  assert.equal(info.gateways[0].gateway, "slack");
  assert.deepEqual(JSON.parse(await tool.execute({ action: "destinations", gateway: "slack" }, { sessionKey: "main" })).destinations, [{ target: "C1", name: "channel" }]);
  assert.ok(workflowTools(["read"], false, false)?.includes("plugin_message"));
  assert.deepEqual(workflowTools([], false, false), []);
  const text = capabilityContext({ revision: 1, sessionKey: "main", registeredTools: ["plugin_message"], selectedTools: undefined,
    dispatcherEnabled: false, dispatcherReady: false, reviewInstructions: "", messagingGateways: f.gateways.messagingCapabilities() });
  assert.match(text, /plugin_message send/); assert.match(text, /"gateway":"slack"/);
  assert.doesNotMatch(text, /SLACK_BOT_TOKEN|private-bot/); // no credential values in host facts
  const hidden = capabilityContext({ revision: 1, sessionKey: "main", registeredTools: ["plugin_message"], selectedTools: [],
    dispatcherEnabled: false, dispatcherReady: false, reviewInstructions: "", messagingGateways: f.gateways.messagingCapabilities() });
  assert.match(hidden, /native messaging tool is not exposed/);
  assert.doesNotMatch(hidden, /To send an operator-authorized message use plugin_message send/);
});

test("one authorized send has a durable receipt; identical retries survive service recreation without replay", async t => {
  const f = await fixture(t), tool = await f.open();
  const first = JSON.parse(await tool.execute(send, { sessionKey: "main" }));
  assert.equal(first.status, "delivered"); assert.equal(f.calls, 1);
  const reopened = await f.open();
  assert.deepEqual(JSON.parse(await reopened.execute(send, { sessionKey: "main" })), first);
  assert.equal(f.calls, 1);
  await assert.rejects(reopened.execute({ ...send, text: "different" }, { sessionKey: "main" }), /different message/);
  assert.equal(JSON.parse(await reopened.execute({ action: "receipt", requestId: "request-1" }, { sessionKey: "main" })).status, "delivered");
  await assert.rejects(reopened.execute({ action: "receipt", requestId: "request-1" }, { sessionKey: "other" }), /Unknown/);
  const raw = await readFile(path.join(f.home, "message-receipts", (await readdir(path.join(f.home, "message-receipts")))[0]), "utf8");
  assert.ok(!raw.includes(send.text));
});

test("concurrent identical retries make only one transport attempt", async t => {
  const f = await fixture(t), tool = await f.open();
  const receipts = await Promise.all(Array.from({ length: 8 }, () => tool.execute(send, { sessionKey: "main" })));
  assert.equal(new Set(receipts).size, 1); assert.equal(f.calls, 1);
});

test("unknown external effect is retained as uncertain and never automatically replayed", async t => {
  const f = await fixture(t), tool = await f.open(); let calls = 0;
  f.gateways.sendMessage = async () => { calls++; throw Error("secret provider detail"); };
  const receipt = JSON.parse(await tool.execute(send, { sessionKey: "main" }));
  assert.equal(receipt.status, "uncertain"); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(receipt), /secret/);
  await (await f.open()).execute(send, { sessionKey: "main" }); assert.equal(calls, 1);
});

test("aborted and malformed sends cannot reach the transport", async t => {
  const f = await fixture(t), tool = await f.open();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(tool.execute(send, { sessionKey: "main", signal: abort.signal }));
  for (const input of [{ ...send, requestId: "" }, { ...send, text: "" }, { ...send, gateway: "../bad" }])
    await assert.rejects(tool.execute(input, { sessionKey: "main" }));
  assert.equal(f.calls, 0);
});
