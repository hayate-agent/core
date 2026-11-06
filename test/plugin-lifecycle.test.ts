import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../src/plugins.js";

const context = { home: "/tmp", cwd: "/tmp", agent: "test" };
test("stop drains async activation and all concurrent callers await the same cleanup", async () => {
  const host = new PluginHost(); let release!: () => void; let clean = 0;
  const wait = new Promise<void>(r => { release = r; });
  const loading = host.load([], context, [], [], [{ apiVersion: 1, async activate(api) {
    await wait;
    api.registerCommand({ name: "late", help: "test", run: async () => "late" });
    api.onStop(() => { clean++; });
  } }]);
  const stop = host.stop(); assert.equal(host.stop(), stop);
  let settled = false; void stop.then(() => { settled = true; });
  await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  await assert.rejects(host.load([], context, []), /closed/);
  release(); await loading; await stop;
  assert.equal(clean, 1); assert.equal(host.commands.size, 0);
});
test("overlapping activation rejected and cleanup errors remain visible to every stop caller", async () => {
  const host = new PluginHost(); let release!: () => void;
  const wait = new Promise<void>(r => { release = r; });
  const loading = host.load([], context, [], [], [{ apiVersion: 1, async activate(api) {
    api.onStop(() => { throw Error("cleanup"); }); await wait;
  } }]);
  await assert.rejects(host.load([], context, []), /in progress/);
  release(); await loading;
  const stopped = host.stop(); await assert.rejects(stopped, /Plugin cleanup failed/);
  assert.equal(host.stop(), stopped); await assert.rejects(host.stop(), /Plugin cleanup failed/);
});
test("failed activation cleans registered resources without self-deadlock during stop", async () => {
  const host = new PluginHost(); let release!: () => void; let cleaned = false;
  const wait = new Promise<void>(r => { release = r; });
  const loading = host.load([], context, [], [], [{ apiVersion: 1, async activate(api) {
    api.onStop(() => { cleaned = true; }); await wait; throw Error("activation failure");
  } }]);
  const stop = host.stop(); release();
  await assert.rejects(loading, /activation failure/); await stop; assert.equal(cleaned, true);
});
