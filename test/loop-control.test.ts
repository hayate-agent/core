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
  const h = setup(); let release!: () => void, entered!: () => void;
  const reached = new Promise<void>(r => { entered = r; });
  h.onStateChange = () => new Promise<void>(r => { release = r; entered(); });
  let done = false;
  const setting = h.controlLoop("one", { action: "set", prompt: "x", everyMs: 60000 }).then(() => { done = true; });
  await reached; assert.equal(done, false); release(); await setting;
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

for (const desired of [true, false]) test(`overlapping exact owner controls serialize failed persistence and rollback: paused=${desired}`, async t => {
  const h = setup(); t.after(() => h.stop(0)); const s = h.state("matrix:overlap");
  s.loop = { prompt: "unchanged", everyMs: 60000, nextAt: 0, paused: !desired, remaining: 2 };
  const digest = createHash("sha256").update(JSON.stringify({ prompt: s.loop.prompt, everyMs: s.loop.everyMs })).digest("hex");
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  let writes = 0, persisted: unknown;
  h.onStateChange = async () => { if (++writes === 1) { entered(); await gate; throw Error("injected I/O failure"); } persisted = structuredClone(s.loop); };
  const first = h.freezeLoopForMigration(s.key, digest, desired);
  const failed = assert.rejects(first, /injected I\/O failure/);
  await reached;
  const second = h.freezeLoopForMigration(s.key, digest, desired);
  assert.equal(s.queue.length, 0, "owner control does not enqueue an occurrence");
  assert.equal(writes, 1, "second operation cannot capture state before first rollback");
  release(); await failed; await second;
  assert.equal(s.loop.paused, desired);
  assert.deepEqual(persisted, s.loop);
  assert.equal(writes, 2);
});

test("owner resume cannot authorize a replaced loop with matching prose and interval", async t => {
  const h = setup(); t.after(() => h.stop(0));
  const old = await h.controlLoop("matrix:replace", { action: "set", prompt: "same", everyMs: 60000 });
  const digest = createHash("sha256").update(JSON.stringify({ prompt: old!.prompt, everyMs: old!.everyMs, sourceId: old!.sourceId })).digest("hex");
  await h.controlLoop("matrix:replace", { action: "stop" });
  await h.controlLoop("matrix:replace", { action: "set", prompt: "same", everyMs: 60000 });
  await h.controlLoop("matrix:replace", { action: "pause" });
  await assert.rejects(h.freezeLoopForMigration("matrix:replace", digest, false), /changed since inspection/);
  assert.equal(h.state("matrix:replace").loop!.paused, true);
});

test("timer cannot admit an unpersisted owner resume", async t => {
  const h = setup(); t.after(() => h.stop(0)); const s = h.state("matrix:unpersisted");
  s.loop = { prompt: "unchanged", everyMs: 60000, nextAt: 0, paused: true };
  const digest = createHash("sha256").update(JSON.stringify({ prompt: s.loop.prompt, everyMs: s.loop.everyMs })).digest("hex");
  let entered!: () => void, release!: () => void, writes = 0;
  const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  h.onStateChange = async () => { if (++writes === 1) { entered(); await gate; throw Error("resume persistence failed"); } };
  const resuming = assert.rejects(h.freezeLoopForMigration(s.key, digest, false), /resume persistence failed/);
  await reached; await h.tick();
  assert.equal(s.queue.length, 0);
  assert.equal((h.opts.runtime as FakeRuntime).opened.length, 0);
  release(); await resuming;
  assert.equal(s.loop.paused, true);
});

test("host-owner freeze preserves every queued occurrence and rejects an altered loop", async t => {
  const h = setup(); t.after(() => h.stop(0)); const s = h.state("matrix:room");
  s.loop = { prompt: "original", everyMs: 60000, nextAt: 123456, paused: false, remaining: 4 };
  s.queue.push({ sessionKey: s.key, source: "loop", text: "already admitted" }, { sessionKey: s.key, source: "cron", text: "unrelated" });
  const digest = createHash("sha256").update(JSON.stringify({ prompt: "original", everyMs: 60000 })).digest("hex");
  const dispatcher = {} as any; const freeze = (key: string, hash: string, paused?: boolean) => h.freezeLoopForMigration(key, hash, paused);
  await assert.rejects(executionControlRequest(dispatcher, { op: "freeze-loop", parent: s.key, digest: "0".repeat(64) }, undefined, freeze));
  assert.equal(s.loop.paused, false);
  await executionControlRequest(dispatcher, { op: "freeze-loop", parent: s.key, digest }, undefined, freeze);
  assert.deepEqual(s.queue.map(i => i.text), ["already admitted", "unrelated"]);
  assert.deepEqual(s.loop, { prompt: "original", everyMs: 60000, nextAt: 123456, paused: true, remaining: 4 });
  const restored = setup(); restored.restoreSessions(structuredClone(h.snapshotSessions()));
  assert.equal(restored.state(s.key).loop?.paused, true); await restored.stop(0);
  await assert.rejects(executionControlRequest(dispatcher, { op: "freeze-loop", parent: s.key, digest, unexpected: true }, undefined, freeze));
  const before = structuredClone(h.snapshotSessions());
  await assert.rejects(executionControlRequest(dispatcher, { op: "resume-loop", parent: s.key, digest: "0".repeat(64) }, undefined, freeze));
  assert.deepEqual(h.snapshotSessions(), before);
  await executionControlRequest(dispatcher, { op: "resume-loop", parent: s.key, digest }, undefined, freeze);
  await executionControlRequest(dispatcher, { op: "resume-loop", parent: s.key, digest }, undefined, freeze);
  assert.deepEqual(s.loop, { prompt: "original", everyMs: 60000, nextAt: 123456, paused: false, remaining: 4 });
  assert.deepEqual(s.queue.map(i => i.text), ["already admitted", "unrelated"]);
  h.onStateChange = async () => { throw Error("save failed"); };
  await assert.rejects(h.freezeLoopForMigration(s.key, digest), /save failed/);
  assert.equal(s.loop.paused, false, "failed save rolls back only the in-memory pause transition");
  await assert.rejects(executionControlRequest(dispatcher, { op: "resume-loop", parent: s.key, digest, unexpected: true }, undefined, freeze));
});
