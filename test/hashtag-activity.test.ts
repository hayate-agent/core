import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { taskContextLabel } from "../src/builtin-plugins/execution-metadata.js";
import { NativeActivityDelivery } from "../src/builtin-plugins/native-activity.js";
import { ExecutionStore } from "../src/execution.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import type { ActivityEvent } from "../src/activity.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";

async function idle(h: Harness) {
  for (let i = 0; i < 500; i++) { if (h.isDrained()) return; await new Promise(r => setTimeout(r, 5)); }
  throw Error("Harness did not drain");
}

test("actual channel activity renderer labels the first opening event and every phase from the original turn", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tag-activity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rows: string[] = [], snapshots: ActivityEvent[] = [];
  const native = new NativeActivityDelivery(path.join(home, "native.json"), async (_to, _id, text) => { rows.push(text); }, 60000);
  const runtime = new FakeRuntime(() => "answer");
  const recalls: string[] = [];
  const h = new Harness({ runtime, tickMs: 60000, busyMode: "queue", memory: {
    recall: async key => { recalls.push(key); return ""; }, capture: async () => {},
  } });
  const channel = Object.assign(new MemoryChannel(), { taskActivity: (to: typeof ROOM, event: ActivityEvent) => {
    snapshots.push(event); native.event(to, event);
  } });
  h.addChannel(channel); await h.start();
  t.after(async () => { native.stop(); await h.stop(1000); });
  await h.accept(msg("topic A #alpha")); await idle(h); await native.flush();
  assert.ok(snapshots.length >= 3);
  assert.equal(snapshots[0]!.snapshot.phase, "starting");
  assert.deepEqual(snapshots[0]!.snapshot.outputTags, ["alpha"]);
  assert.equal(rows.at(-1), `${taskContextLabel(snapshots[0]!.snapshot.id, ["alpha"])} · Main · 0s · model unavailable · reasoning unavailable · completed`);
  const firstSession = runtime.sessions.get("mem:room1");
  await h.accept(msg("topic B #beta")); await idle(h); await native.flush();
  assert.equal(rows.at(-1), `${taskContextLabel(snapshots.at(-1)!.snapshot.id, ["beta"])} · Main · 0s · model unavailable · reasoning unavailable · completed`);
  assert.equal(runtime.sessions.get("mem:room1"), firstSession, "tags do not select another SDK session");
  assert.equal(runtime.opened.length, 1);
  assert.equal(firstSession!.prompts.length, 2);
  assert.deepEqual(recalls, ["mem:room1", "mem:room1"], "memory recall boundary is conversation, not tag");
  // A late host event must remain A, not inherit the most recent B.
  native.event(ROOM, snapshots[0]!); await native.flush();
  assert.match(rows.at(-1)!, /^task [a-f0-9-]+ · #alpha · Main/);
  await h.accept(msg("legacy untagged")); await idle(h); await native.flush();
  assert.match(rows.at(-1)!, /^task [a-f0-9-]+ · (untagged|context unknown) · Main/);
});

test("stored worker origin overrides spoofed snapshot labels; lifecycle and question retain exact controls", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tag-worker-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const task = await store.submit("mem:room1", "a", "A", "direct", 1, {
    key: "a", scope: "example", checkpoint: { at: 1 }, anchor: { id: "anchor-a", task: "A", receivedAt: 1, replyTo: ROOM, outputTags: ["alpha"] },
  });
  const claimed = await store.claim(task.id);
  store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const rows: string[] = [];
  const native = new NativeActivityDelivery(path.join(home, "native.json"), async (_to, _id, text) => { rows.push(text); }, 60000);
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, tickMs: 60000 });
  h.addChannel(Object.assign(new MemoryChannel(), { taskActivity: (to: typeof ROOM, e: ActivityEvent) => native.event(to, e) }));
  await h.start(); t.after(async () => { native.stop(); await h.stop(1000); });
  await h.accept(msg("new B #beta")); await idle(h);
  const bridge = new DispatcherRuntime(h, store);
  const key = `dispatch:${task.id}:${claimed.token}`;
  bridge.channel.taskActivity!( { channel: "dispatch", target: `${task.id}:${claimed.token}` }, {
    type: "activity", kind: "progress", snapshot: { id: "old-worker", role: "worker", outputTags: ["spoof"], context: "worker", phase: "completed", activity: "turn settled", tools: [], elapsedMs: 28000, inactiveMs: 0 },
  }, { sessionKey: key, source: "host", text: "#spoof" });
  await native.flush();
  assert.equal(rows.at(-1), `${taskContextLabel(task.id, ["alpha"])} · Worker · 28s · model unavailable · reasoning unavailable · completed`);
  for (const event of store.events()) assert.match(bridge.eventText(event), /^task [a-f0-9-]+ · #alpha · Dispatcher — /);
  await store.ask(task.id, claimed.token!, "Which target?");
  const question = store.events().find(e => e.type === "question")!;
  const text = bridge.eventText(question);
  assert.match(text, /^task [a-f0-9-]+ · #alpha · Dispatcher — Which target\?/);
  assert.ok(text.includes(`/dispatch answer ${task.id} ${store.list()[0]!.question!.id} <Antwort>`));
  assert.equal(text.split("#alpha").length - 1, 1);
});

test("native persisted restart recovery keeps labels and legacy stays untagged", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tag-restart-")); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "native.json"), rows: string[] = [];
  const send = async (_to: typeof ROOM, _id: string, text: string) => { rows.push(text); };
  const native = new NativeActivityDelivery(file, send, 60000);
  native.event(ROOM, { type: "activity", kind: "progress", tool: { callId: "read", name: "read", state: "started" }, snapshot: {
    id: "A", role: "main", context: "operator", outputTags: ["alpha"], phase: "tool", activity: "tool running", tools: [], elapsedMs: 0, inactiveMs: 0,
  } });
  await native.flush(); native.stop();
  const reopened = new NativeActivityDelivery(file, send, 60000); t.after(() => reopened.stop());
  reopened.metadata(ROOM, "legacy", "running"); await reopened.flush();
  assert.ok(rows.includes(`${taskContextLabel("A", ["alpha"])} · Main · 0s · model unavailable · reasoning unavailable · Werkzeug read: interrupted (host restart)`));
  assert.equal(rows.at(-1), "Dispatcher: running");
});
