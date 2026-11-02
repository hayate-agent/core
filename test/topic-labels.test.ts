import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { semanticTopicLabeler } from "../src/topic-labels.js";
import { Harness } from "../src/harness.js";
import { Dispatcher } from "../src/dispatcher.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import type { ActivityEvent } from "../src/activity.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error("did not settle");
}

test("semantic classifier generates, reuses exact umbrella tags, rejects ambiguity, invalid responses and outage", async () => {
  let raw = '{"topic":null,"tags":["hashtag-routing"]}';
  const label = semanticTopicLabeler({ review: async (_p, model, thinking) => {
    assert.equal(model, "configured/checker"); assert.equal(thinking, "off"); return raw;
  } }, () => "configured/checker");
  assert.deepEqual(await label("Implement automatic topic labels", []), ["hashtag-routing"]);
  raw = '{"topic":"a","tags":["worker-activity"]}';
  assert.deepEqual(await label("repair worker activity", [{ id: "a", text: "labels", tags: ["hashtags", "routing"] }]), ["hashtags", "routing", "worker-activity"]);
  for (raw of ['{"ambiguous":true}', '{"topic":"unknown","tags":["x"]}', '{"topic":null,"tags":[]}', '{"topic":null,"tags":["#spoof"]}', 'not json', 'null']) {
    await assert.rejects(label("Weiter?", []), /Automatic topic labels:|ambiguous topic/);
  }
  await assert.rejects(semanticTopicLabeler({ review: async () => { throw Error("SECRET"); } }, () => undefined)("work", []), error => !String(error).includes("SECRET"));
  let signal: AbortSignal | undefined;
  const timeout = semanticTopicLabeler({ review: async (_p, _m, _t, s) => { signal = s; return new Promise(() => {}); } }, () => undefined, 5);
  await assert.rejects(timeout("work", []), /timeout/); assert.equal(signal?.aborted, true);
});

test("automatic ingress anchor reaches real dispatcher, worker opening/tool activity, final result and durable retry", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "auto-topic-"));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  let dispatcher: Dispatcher;
  const runtime = new FakeRuntime(() => "worker answer");
  const open = runtime.open.bind(runtime);
  runtime.open = async (key, options) => {
    const session = await open(key, options);
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, opts) => {
      if (key === "mem:room1") { await dispatcher.submit(key, "request-1", "delegated work #spoof"); return "parent answer"; }
      opts?.onEvent?.({ type: "tool", phase: "start", callId: "call", name: "read" });
      return prompt(text, opts);
    };
    return session;
  };
  let calls = 0;
  const h = new Harness({ runtime, tickMs: 60000, busyMode: "queue", executionStore: store,
    topicLabeler: semanticTopicLabeler({ review: async () => { calls++; return '{"topic":null,"tags":["automatic-topics"]}'; } }, () => "checker") });
  const bridge = new DispatcherRuntime(h, store);
  dispatcher = new Dispatcher(store, bridge.strategy, 1, async () => {}, error => { throw error; }, key => h.dependencyCheckpoint(key));
  const events: ActivityEvent[] = [];
  const channel = Object.assign(new MemoryChannel(), { taskActivity: (_to: unknown, event: ActivityEvent) => { events.push(event); } });
  h.addChannel(channel); h.addChannel(bridge.channel);
  let persisted: ReturnType<Harness["pendingInputs"]> = [];
  h.onStateChange = async () => {
    const pending = h.pendingInputs();
    if (pending[0]?.completionAnchor) persisted = structuredClone(pending);
  };
  await h.start(); await dispatcher.start();
  t.after(async () => { await dispatcher.stop(); await h.stop(1000); await rm(home, { recursive: true, force: true }); });
  const input = { ...msg("Implement automatic semantic topic labels"), id: "input-1", outputTags: ["spoof"] };
  await h.accept(input);
  await until(() => store.list()[0]?.status === "completed" && h.isDrained());
  assert.deepEqual(persisted[0]?.completionAnchor?.outputTags, ["automatic-topics"]);
  const saved = structuredClone(persisted);
  await h.accept({ ...input }); assert.equal(calls, 1, "upstream duplicate never reclassifies");
  await until(() => store.list()[0]?.status === "completed" && h.isDrained());
  assert.deepEqual(store.list()[0]?.dependency?.anchor, saved[0]?.completionAnchor);
  assert.ok(events.some(e => e.snapshot.role === "worker" && e.snapshot.phase === "starting"));
  assert.ok(events.some(e => e.snapshot.role === "worker" && e.tool?.name === "read"));
  for (const event of events) assert.deepEqual(event.snapshot.outputTags, ["automatic-topics"]);
  assert.equal(channel.texts().at(-1), "#automatic-topics · parent answer");
  const reloaded = new ExecutionStore(file); await reloaded.load();
  assert.deepEqual(reloaded.list()[0]?.dependency?.anchor?.outputTags, ["automatic-topics"]);
  assert.equal(bridge.labelEvent({ id: "result", executionId: store.list()[0]!.id, parent: "mem:room1", type: "result", text: "result", delivered: false }, "result"), "#automatic-topics · result");
  // A persisted accepted inbox is replayed without semantic service access.
  const restored = new Harness({ runtime: new FakeRuntime(() => "replayed"), tickMs: 60000,
    topicLabeler: async () => { throw Error("must not reclassify"); } });
  restored.restorePending(saved); const replayChannel = new MemoryChannel(); restored.addChannel(replayChannel);
  await restored.start(); restored.releaseRestored(); await until(() => restored.isDrained());
  assert.equal(replayChannel.texts().at(-1), "#automatic-topics · replayed"); await restored.stop(1000);
});

test("interleaved topics select semantic origin rather than latest topic; explicit tags and API cannot be replaced", async t => {
  let calls = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => "answer"), tickMs: 60000, busyMode: "queue",
    topicLabeler: semanticTopicLabeler({ review: async prompt => {
      calls++;
      const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
      const candidate = data.candidates.find((c: { text: string }) => c.text.includes("database"));
      return JSON.stringify({ topic: candidate.id, tags: ["connection-retry"] });
    } }, () => undefined) });
  const channel = new MemoryChannel(); h.addChannel(channel); await h.start(); t.after(() => h.stop(1000));
  await h.accept(msg("repair database #storage")); await until(() => h.isDrained());
  await h.accept(msg("repair DNS #network")); await until(() => h.isDrained());
  await h.accept(msg("Continue the database repair")); await until(() => h.isDrained());
  assert.equal(channel.texts().at(-1), "#connection-retry #storage · answer");
  assert.equal(calls, 1);
  await h.accept({ ...msg("#spoof"), source: "api", outputTags: ["spoof"], completionAnchor: { id: "fake", task: "x", receivedAt: 1, outputTags: ["spoof"] } });
  await until(() => h.isDrained()); assert.equal(channel.texts().at(-1), "answer"); assert.equal(calls, 1);
});

for (const failure of ["outage", "timeout"]) test(`${failure}: durable ingress survives restart, tick recovers without resend exactly once`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "topic-restart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { writeFile, readFile } = await import("node:fs/promises");
  const file = path.join(home, "inbox.json");
  let at = 1000, calls = 0, turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "answer"; }), now: () => at, tickMs: 60000,
    topicLabeler: semanticTopicLabeler({ review: async () => {
      calls++; if (failure === "timeout") return new Promise(() => {}); throw Error("offline");
    } }, () => undefined, 5) });
  h.onStateChange = async () => writeFile(file, JSON.stringify({ pending: h.pendingInputs(), seen: h.seenIds() }));
  const channel = new MemoryChannel(); h.addChannel(channel); await h.start();
  const input = { ...msg("work"), id: "stable-message" };
  await h.accept(input); // durable acknowledgement, no provider dependency
  await until(() => (h.pendingInputs()[0]?.topicPending?.attempts ?? 0) === 1);
  await until(() => calls === 1);
  await h.accept({ ...msg("work"), id: "stable-message" });
  assert.equal(calls, 1); assert.equal(turns, 0);
  await h.accept({ ...msg("independent work #explicit"), id: "explicit-during-outage" });
  await until(() => channel.texts().includes("#explicit · answer"));
  assert.equal(turns, 1); assert.equal(calls, 1);
  h.commandHandler = async () => true; await h.accept(msg("/stop"));
  await h.stop(1000);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.pending.length, 1); assert.equal(saved.pending[0].id, "stable-message");
  let recoveredCalls = 0;
  const restored = new Harness({ runtime: new FakeRuntime(() => { turns++; return "answer"; }), now: () => at, tickMs: 60000,
    topicLabeler: async () => { recoveredCalls++; return ["recovery"]; } });
  restored.onStateChange = async () => writeFile(file, JSON.stringify({ pending: restored.pendingInputs(), seen: restored.seenIds() }));
  restored.restoreSeen(saved.seen); restored.restorePending(saved.pending);
  const output = new MemoryChannel(); restored.addChannel(output); await restored.start(); restored.releaseRestored();
  await restored.tick(); assert.equal(recoveredCalls, 0, "persisted backoff survives restart");
  at += 15000; await restored.tick(); await until(() => restored.isDrained());
  await restored.accept({ ...msg("work"), id: "stable-message" }); await restored.tick();
  assert.equal(recoveredCalls, 1); assert.equal(turns, 2);
  assert.deepEqual(output.texts(), ["#recovery · answer"]);
  await restored.stop(1000);
});

test("genuine ambiguity asks narrow clarification, never executes or retries; explicit input remains usable", async () => {
  let calls = 0, turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "answer"; }), tickMs: 60000,
    topicLabeler: semanticTopicLabeler({ review: async () => { calls++; return '{"ambiguous":true}'; } }, () => undefined) });
  const channel = new MemoryChannel(); h.addChannel(channel); await h.start();
  await h.accept({ ...msg("Weiter?"), id: "ambiguous" }); await until(() => h.isDrained());
  assert.match(channel.texts()[0]!, /Welchem Thema/); assert.equal(turns, 0);
  await h.tick(); await h.accept({ ...msg("Weiter?"), id: "ambiguous" }); assert.equal(calls, 1);
  await h.accept(msg("work #explicit")); await until(() => h.isDrained());
  assert.equal(turns, 1); assert.equal(calls, 1); await h.stop(1000);
});
