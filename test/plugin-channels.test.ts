// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PluginHost } from "../src/plugins.js";
import { Harness } from "../src/harness.js";
import { installCommands } from "../src/commands.js";
import { FakeRuntime } from "./fakes.js";

async function fixture(body: string, run: (host: PluginHost) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-channel-"));
  const host = new PluginHost();
  try {
    await writeFile(path.join(home, "channel.mjs"), `export default {apiVersion:1,activate(api){${body}}}`);
    await host.load(["channel.mjs"], { home, cwd: home, agent: "fixture" }, []);
    await run(host);
  } finally { await host.stop(); await rm(home, { recursive: true, force: true }); }
}

const transport = `api.registerChannel({name:'remote',
  async start(deliver){globalThis.testPluginDeliver=deliver},
  async send(to,text){globalThis.testPluginReplies.push({to,text})},
  async stop(){globalThis.testPluginStopped=true}
});`;

test("plugin channel routes through Harness, namespaces inputs and preserves admin checks", async () => {
  (globalThis as any).testPluginReplies = [];
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, log: () => {} });
  try {
    await fixture(transport, async (host) => {
      for (const channel of host.channels.values()) harness.addChannel(channel);
      installCommands({ harness, approvals: { mode: "off", tools: [] }, skills: () => [], reloadSkills: async () => {},
        personality: { current: undefined, available: async () => [], set: async () => {} },
        admins: [], openAdmin: false, agent: "fixture", restart: async () => {} });
      await harness.start();
      const deliver = (globalThis as any).testPluginDeliver;
      // Extra raw fields from a transport cannot impersonate the local console/API.
      await deliver({ session: 'local', target: 'room', text: '/pause', source:'api', replyTo:{channel:'console'}, sessionKey:'console:local' });
      assert.match((globalThis as any).testPluginReplies.at(-1).text, /admin only/);
      await deliver({ session: 'local', target: 'room', text: 'hello', id: 'id1' });
      await harness.drained();
      const reply = (globalThis as any).testPluginReplies.at(-1);
      assert.equal(reply.to.channel, 'remote');
      assert.equal(reply.to.target, 'room');
      assert.equal(reply.text, 'echo: hello');
      assert.ok(harness.state('plugin:remote:local'));
      const count = (globalThis as any).testPluginReplies.length;
      await deliver({ session: 'local', target: 'room', text: 'hello', id: 'id1' });
      await harness.drained();
      assert.equal((globalThis as any).testPluginReplies.length, count);
      await assert.rejects(deliver({session: '', target:'room', text:'bad'}), /Invalid message/);
      await harness.stop(1000);
      assert.equal((globalThis as any).testPluginStopped, true);
    });
  } finally {
    await harness.stop(0);
    for (const key of ['testPluginReplies','testPluginDeliver','testPluginStopped']) delete (globalThis as any)[key];
  }
});

test("plugin channels reject non-string names at startup", async () => {
  for (const name of ['undefined', 'null', "{toString(){return 'remote'}}"]) {
    await assert.rejects(fixture(transport.replace("name:'remote'", `name:${name}`), async () => {}), /Invalid plugin channel/);
  }
});

test("plugin channels cannot claim trusted or existing transport names", async () => {
  await assert.rejects(fixture(transport.replace("name:'remote'", "name:'console'"), async () => {}), /Channel conflict/);
  await assert.rejects(fixture(transport + transport, async () => {}), /Channel conflict/);
});
