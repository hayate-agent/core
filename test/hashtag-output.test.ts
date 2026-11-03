import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { OutboxDelivery, type OutboxEntry } from "../src/delivery/outbox.js";
import { labelOutput } from "../src/hashtags.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";

async function idle(h: Harness) {
  for (let i = 0; i < 500; i++) { if (h.isDrained()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error("Harness did not drain");
}

test("direct Main labels trusted operator tags without a dispatcher; no carryover or API spoofing", async () => {
  const channel = new MemoryChannel();
  const h = new Harness({ runtime: new FakeRuntime(() => "#fake · answer"), tickMs: 60000, busyMode: "queue" });
  h.addChannel(channel); await h.start();
  try {
    await h.accept(msg('build #Rollout #hashtags\n> #spoof')); await idle(h);
    assert.equal(channel.texts().at(-1), "#hashtags #rollout · answer");
    await h.accept(msg("unrelated")); await idle(h);
    assert.equal(channel.texts().at(-1), "#fake · answer");
    await h.accept({ ...msg("api #spoof"), source: "api", outputTags: ["spoof"] }); await idle(h);
    assert.equal(channel.texts().at(-1), "#fake · answer");
    assert.equal(h.state("mem:room1").hashtags, undefined); // fake runtime has no transcript references
  } finally { await h.stop(1000); }
});

test("persisted outbox retry labels once, never mutates text, and legacy stays untagged", async () => {
  const sent: string[] = [];
  let fail = true;
  const deps = { save: async () => {}, log: () => {}, deliver: async (_: unknown, text: string) => { sent.push(text); if (fail) throw Error("offline"); } };
  const first = new OutboxDelivery(deps);
  let entries = [first.create("p", ROOM, "#wrong · answer", undefined, ["rollout", "hashtags"])];
  assert.equal(await first.flush("p", entries), false);
  entries = JSON.parse(JSON.stringify(entries)); fail = false;
  await new OutboxDelivery(deps).flush("p", entries);
  assert.deepEqual(sent, ["#hashtags #rollout · answer", "#hashtags #rollout · answer"]);
  const legacy: OutboxEntry[] = [{ sessionKey: "p", to: ROOM, text: "old" }];
  await first.flush("p", legacy); assert.equal(sent.at(-1), "old");
  assert.equal(labelOutput("", ["tag"]), "");
});

test("queued Main assignment survives restart, and late host result uses execution tags not current topic", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "output-labels-"));
  let h: Harness | undefined;
  try {
    const file = path.join(home, "executions.json");
    let store = new ExecutionStore(file); await store.load();
    const execution = await store.submit("mem:room1", "r", "worker #untrusted", "direct", 1,
      { taskId: "original", original: "work", depth: 0, anchor: { id: "a", task: "work", receivedAt: 1, replyTo: { ...ROOM, thread: "original-thread" }, outputTags: ["old"] } });
    const claim = await store.claim(execution.id); await store.complete(execution.id, claim.token!, "worker #spoof");
    store = new ExecutionStore(file); await store.load();
    const channel = new MemoryChannel();
    h = new Harness({ runtime: new FakeRuntime(() => "answer"), executionStore: store, hostEventAllowed: () => true, tickMs: 60000 });
    h.restorePending(JSON.parse(JSON.stringify([{ ...msg("queued #new"), replyTo: { ...ROOM, thread: "new-thread" }, outputTags: ["new"], completionAnchor: { id: "b", task: "queued #new", receivedAt: 2, outputTags: ["new"] } }])));
    h.addChannel(channel); await h.start(); h.releaseRestored(); await idle(h);
    assert.equal(channel.texts().at(-1), "#new · answer");
    const bridge = new DispatcherRuntime(h, store);
    assert.deepEqual(store.list()[0]!.dependency!.anchor!.replyTo, { ...ROOM, thread: "original-thread" });
    for (const type of ["question", "status", "result"] as const) {
      const event = { id: type, parent: "mem:room1", executionId: execution.id, type, text: "#spoof · payload", delivered: false };
      assert.equal(bridge.labelEvent(event, "#spoof · payload"), "#old · payload");
      assert.equal(bridge.labelEvent({ ...event, parent: "other-room" }, "payload"), "payload");
      await h.deliver(store.list()[0]!.dependency!.anchor!.replyTo!, bridge.labelEvent(event, "payload"));
      assert.deepEqual(channel.sent.at(-1)!.to, { ...ROOM, thread: "original-thread" });
      assert.equal(channel.texts().at(-1), "#old · payload");
    }
    await h.accept({ sessionKey: "mem:room1", source: "host", hostEvent: { executionId: execution.id }, text: "worker #spoof", replyTo: ROOM }); await idle(h);
    assert.equal(channel.texts().at(-1), "#old · answer");
    assert.deepEqual(channel.sent.at(-1)!.to, { ...ROOM, thread: "original-thread" });
    await h.accept(msg("next unrelated")); await idle(h);
    assert.equal(channel.texts().at(-1), "answer");
  } finally { await h?.stop(1000); await rm(home, { recursive: true, force: true }); }
});
