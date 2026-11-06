// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
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
