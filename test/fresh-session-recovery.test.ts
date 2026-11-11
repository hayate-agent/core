import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import type { Inbound } from "../src/types.js";
import { ExecutionStore } from "../src/execution.js";
import { Dispatcher } from "../src/dispatcher.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const settle = () => new Promise(resolve => setTimeout(resolve, 30));
test("fresh session never executes, delivers or charges historical unfinished inputs; explicit selection resumes only its owner", async () => {
  let selected = "local-new";
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, sessionEnabled: key => key === selected });
  harness.onStateChange = async () => {};
  const channel = new MemoryChannel(); harness.addChannel(channel);
  const old: Inbound = { id: "old-input", sessionKey: "local-old", source: "channel", text: "old authorized work", started: true, replays: 2, replyTo: { channel: "mem", target: "old" } };
  harness.restorePending([old]);
  await harness.start(); harness.releaseRestored(); await harness.tick(); await settle();
  assert.equal(runtime.opened.length, 0);
  assert.equal(channel.sent.length, 0);
  assert.equal(harness.pendingInputs()[0]!.started, true);
  assert.equal(harness.pendingInputs()[0]!.replays, 2, "opening an unrelated session is not a replay");
  await harness.accept({ id: "fresh", sessionKey: selected, source: "channel", text: "new question", replyTo: { channel: "mem", target: "new" } });
  await settle(); assert.ok(runtime.sessions.has("local-new")); assert.ok(!runtime.sessions.has("local-old"));
  selected = "local-old";
  await harness.activateSession(selected); await settle();
  assert.equal(runtime.sessions.get("local-old")!.prompts.length, 1);
  assert.equal(channel.sent.filter(r => r.to.target === "old").length, 1);
  await harness.stop(1000);
});

test("parked dispatcher work is not claimed/delivered until explicit parent selection, including a claim race", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fresh-dispatch-"));
  let enabled = false, runs = 0, delivered = 0;
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const task = await store.submit("local-old", "old", "preserve original", "test");
  const dispatcher = new Dispatcher(store, { name: "test", version: 1, replaySafe: true, execute: async () => { runs++; return "done"; } },
    1, async () => { delivered++; }, () => {}, undefined, undefined, () => false, [], () => enabled);
  t.after(async () => {
    await dispatcher.stop();
    await rm(dir, { recursive: true, force: true });
  });
  await dispatcher.start(); await settle();
  assert.equal(store.list()[0]!.status, "ready"); assert.equal(delivered, 0); assert.equal(runs, 0);
  const claim = store.claim.bind(store);
  store.claim = async (...args) => { const claimed = await claim(...args); enabled = false; return claimed; };
  enabled = true; await dispatcher.activateParent("local-old"); await settle();
  assert.equal(store.list()[0]!.status, "ready"); assert.equal(runs, 0);
  store.claim = claim; enabled = true; await dispatcher.activateParent("local-old");
  const end = Date.now() + 2000; while (store.list()[0]!.status !== "completed" && Date.now() < end) await settle();
  assert.equal(store.list()[0]!.id, task.id); assert.equal(runs, 1); assert.equal(store.list()[0]!.status, "completed");
});

test("parked conversations remain in shutdown snapshot without blocking an idle drain", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, sessionEnabled: key => key === "new" });
  harness.onStateChange = async () => {};
  harness.restorePending([{ id: "old", sessionKey: "old", source: "channel", text: "retain me", started: true, replays: 1 }]);
  harness.releaseRestored();
  const start = Date.now(), pending = await harness.stop(1000);
  assert.ok(Date.now() - start < 500);
  assert.equal(pending.length, 1); assert.equal(pending[0]!.id, "old");
  assert.equal(runtime.opened.length, 0);
});
