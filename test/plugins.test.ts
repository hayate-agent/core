import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PluginHost } from "../src/plugins.js";

async function fixture(code: string, run: (host: PluginHost, home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-plugin-"));
  const host = new PluginHost();
  try {
    await writeFile(path.join(home, "plugin.mjs"), code);
    await run(host, home);
  } finally { await host.stop().catch(() => {}); await rm(home, { recursive: true, force: true }); }
}
const context = (home: string) => ({ home, cwd: home, agent: "fixture" });

test("plugins explicitly load commands with safe defaults and idempotent cleanup", async () => {
  await fixture(`export default {apiVersion:1, activate(api) {
    api.registerCommand({name:'greet',help:'Greet',async run(args,ctx){return api.agent+':'+args+':'+ctx.sessionKey}});
    api.onStop(()=>{globalThis.pluginCleanup=(globalThis.pluginCleanup||0)+1});
  }}`, async (host, home) => {
    await host.load(["plugin.mjs"], context(home), []);
    const command = host.commands.get("greet")!;
    assert.equal(command.admin, true);
    assert.equal(await command.run("hello", { sessionKey: "local" }), "fixture:hello:local");
    await host.stop(); await host.stop();
    assert.equal((globalThis as any).pluginCleanup, 1);
    delete (globalThis as any).pluginCleanup;
  });
});

test("plugins reject builtin/skill conflicts and roll back registration", async () => {
  await fixture(`export default {apiVersion:1, activate(api){api.registerCommand({name:'help',help:'bad',async run(){}})}}`, async (host, home) => {
    await assert.rejects(host.load(["plugin.mjs"], context(home), ["help"]), /Command conflict/);
    assert.equal(host.commands.size, 0);
  });
});

test("failed activation runs every cleanup in reverse order even after cleanup failure", async () => {
  await fixture(`export default {apiVersion:1, activate(api){
    api.onStop(()=>globalThis.pluginOrder.push(1));
    api.onStop(()=>{globalThis.pluginOrder.push(2);throw Error('cleanup')});
    throw Error('activation');
  }}`, async (host, home) => {
    (globalThis as any).pluginOrder = [];
    await assert.rejects(host.load(["plugin.mjs"], context(home), []), /activation/);
    assert.deepEqual((globalThis as any).pluginOrder, [2, 1]);
    delete (globalThis as any).pluginOrder;
  });
});

test("incompatible plugin version fails startup", async () => {
  await fixture(`export default {apiVersion:2,activate(){}}`, async (host, home) => {
    await assert.rejects(host.load(["plugin.mjs"], context(home), []), /Invalid plugin API/);
  });
});
