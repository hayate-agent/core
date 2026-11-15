import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { executionControlRequest } from "../src/execution-control.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { loopPlugin } from "../src/builtin-plugins/loop-plugin.js";

function setup() {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  harness.onStateChange = async () => {};
  return harness;
}
test("loop controls preserve conversation scope, snapshot state, pause and replace queued prompts", async () => {
  const h = setup(); const s = h.state("one");
  await h.controlLoop("two", { action: "set", prompt: "other", everyMs: 60000 });
  s.queue.push({ sessionKey: "one", source: "loop", text: "old" }, { sessionKey: "one", source: "cron", text: "keep" });
  await h.controlLoop("one", { action: "set", prompt: "new", everyMs: 60000, times: 2 });
  assert.deepEqual(s.queue.map(x => x.text), ["keep"]);
  const snapshot = await h.controlLoop("one", { action: "status" }); snapshot!.prompt = "mutated";
  assert.equal(s.loop!.prompt, "new");
  await h.controlLoop("one", { action: "pause" }); assert.equal(s.loop!.paused, true);
  await h.controlLoop("one", { action: "resume" }); assert.equal(s.loop!.paused, false);
  const restored = setup(); restored.restoreSessions(structuredClone(h.snapshotSessions()));
  assert.equal((await restored.controlLoop("one", { action: "status" }))!.remaining, 2);
  s.queue.push({ sessionKey: "one", source: "loop", text: "queued" });
  await h.controlLoop("one", { action: "stop" });
  assert.equal(s.loop, undefined); assert.deepEqual(s.queue.map(x => x.text), ["keep"]);
  assert.equal(h.state("two").loop!.prompt, "other");
});
test("loop mutation awaits persistence and reports failure without claiming success", async () => {
  const h = setup(); let release!: () => void;
  h.onStateChange = () => new Promise<void>(r => { release = r; });
  let done = false;
  const setting = h.controlLoop("one", { action: "set", prompt: "x", everyMs: 60000 }).then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); release(); await setting;
  h.onStateChange = async () => { throw Error("disk full"); };
  await assert.rejects(h.controlLoop("one", { action: "stop" }), /disk full/);
  assert.equal(h.state("one").loop, undefined);
  h.onStateChange = undefined;
  await assert.rejects(h.controlLoop("one", { action: "set", prompt: "x", everyMs: 60000 }), /persistence unavailable/);
});
test("invalid loop inputs never mutate state", async () => {
  const h = setup();
  for (const input of [{ action: "set", prompt: " ", everyMs: 60000 }, { action: "set", prompt: "x", everyMs: 1 }, { action: "set", prompt: "x", everyMs: Infinity }, { action: "set", prompt: "x", everyMs: 60000, times: 0 }, { action: "foreign" }]) {
    await assert.rejects(h.controlLoop("one", input)); assert.equal(h.state("one").loop, undefined);
  }
});
test("bundled loop tool uses context session and rejects foreign selectors", async () => {
  const h = setup(); let tool: any;
  await loopPlugin(h).activate({ registerTool: (value: unknown) => { tool = value; } } as any);
  await tool.execute({ action: "set", prompt: "work", everyMs: 60000 }, { sessionKey: "one" });
  assert.equal(h.state("one").loop!.prompt, "work");
  await assert.rejects(tool.execute({ action: "stop", sessionKey: "two" }, { sessionKey: "one" }), /Unknown/);
  await tool.execute({ action: "stop" }, { sessionKey: "one" }); assert.equal(h.state("one").loop, undefined);
});

test("explicit loop run is durable, deduplicated and leaves schedule and held work untouched", async t => {
  const h = setup(); t.after(() => h.stop(0));
  const s = h.state("one"); s.loop = { prompt: "do nothing", everyMs: 60000, nextAt: 9999999999999, paused: false, remaining: 2 };
  const before = structuredClone(s.loop); let count = 0;
  (h.opts.runtime as FakeRuntime).answer = () => { count++; return "NO_REPLY"; };
  await h.runLoopNow("one", "command-1"); await h.waitForSessionIdle("one");
  await h.runLoopNow("one", "command-1"); await h.waitForSessionIdle("one");
  assert.equal(count, 1); assert.deepEqual(s.loop, before);
  s.loop!.paused = true; await assert.rejects(h.runLoopNow("one", "command-2"), /paused/);
});

test("host-owner freeze preserves every queued occurrence and rejects an altered loop", async t => {
  const h = setup(); t.after(() => h.stop(0)); const s = h.state("matrix:room");
  s.loop = { prompt: "original", everyMs: 60000, nextAt: 123456, paused: false, remaining: 4 };
  s.queue.push({ sessionKey: s.key, source: "loop", text: "already admitted" }, { sessionKey: s.key, source: "cron", text: "unrelated" });
  const digest = createHash("sha256").update(JSON.stringify({ prompt: "original", everyMs: 60000 })).digest("hex");
  const dispatcher = {} as any; const freeze = (key: string, hash: string) => h.freezeLoopForMigration(key, hash);
  await assert.rejects(executionControlRequest(dispatcher, { op: "freeze-loop", parent: s.key, digest: "0".repeat(64) }, undefined, freeze));
  assert.equal(s.loop.paused, false);
  await executionControlRequest(dispatcher, { op: "freeze-loop", parent: s.key, digest }, undefined, freeze);
  assert.deepEqual(s.queue.map(i => i.text), ["already admitted", "unrelated"]);
  assert.deepEqual(s.loop, { prompt: "original", everyMs: 60000, nextAt: 123456, paused: true, remaining: 4 });
  const restored = setup(); restored.restoreSessions(structuredClone(h.snapshotSessions()));
  assert.equal(restored.state(s.key).loop?.paused, true); await restored.stop(0);
  await assert.rejects(executionControlRequest(dispatcher, { op: "freeze-loop", parent: s.key, digest, unexpected: true }, undefined, freeze));
});
