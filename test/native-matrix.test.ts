import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MatrixChannel } from "../src/builtin-plugins/matrix-channel.js";
import { TurnActivity } from "../src/activity.js";
import type { ActivityEvent } from "../src/activity.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, msg } from "./fakes.js";

async function fixture(progress: "off" | "tools" = "off") {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-matrix-"));
  const calls: Array<{ url: string; body: any }> = [];
  const ids = new Map<string, string>();
  const options = {
    homeserver: "https://matrix.test", accessToken: "secret", nativeActivity: true, progress,
    allowedUsers: [], allowedRooms: [], freeRooms: [], optionalReplyRooms: [], approvers: [],
    allowAllUsers: false, requireMention: true, autoThread: true, dmAutoThread: false,
    processNotices: false, batchDelayMs: 0, syncStateFile: path.join(home, "sync.json"),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      if (!ids.has(url)) ids.set(url, `$event${ids.size}`);
      return new Response(JSON.stringify({ event_id: ids.get(url) }));
    }) as typeof fetch,
  };
  return { create: () => new MatrixChannel(options), calls, ids };
}
const to = { channel: "matrix", target: "!operator:test", thread: "$thread" };

test("actual Matrix uses one turn reference for concurrent tool calls, host status and cancellation",  async () => {
  const f = await fixture(); const channel = f.create();
  let last!: ActivityEvent;
  const activity = new TurnActivity({ id: "input", role: "worker", context: "worker" }, event => { last = event; channel.taskActivity(to, event); });
  activity.event({ type: "tool", phase: "start", name: "bash", callId: "PI-A", detail: "PRIVATE_SECRET" });
  await channel.flushNativeActivity();
  activity.event({ type: "tool", phase: "start", name: "bash", callId: "PI-B" });
  await channel.flushNativeActivity();
  activity.event({ type: "tool", phase: "end", name: "bash", callId: "PI-A", error: true, detail: "PRIVATE_RESULT" });
  await channel.flushNativeActivity();
  activity.finish("cancelled"); await channel.flushNativeActivity();
  const seeds = f.calls.filter(c => !c.body["m.new_content"]);
  assert.equal(new Set(seeds.map(c => c.url)).size, 1, "all states retry the same seed transaction");
  const edits = f.calls.filter(c => c.body["m.new_content"]);
  assert.ok(edits.some(c => c.body["m.new_content"].body.endsWith("started")));
  assert.ok(edits.some(c => c.body["m.new_content"].body.endsWith("failed")));
  assert.ok(edits.some(c => c.body["m.new_content"].body.includes("cancelled")));
  assert.equal(new Set(edits.map(c => c.body["m.relates_to"].event_id)).size, 1, "not one message per tool call");
  assert.ok(seeds.every(c => c.body["m.relates_to"].event_id === "$thread"));
  assert.ok(!JSON.stringify(f.calls).includes("PRIVATE"));
  assert.ok(!JSON.stringify(f.calls).includes("PI-A"));
  const before = f.calls.length;
  const restarted = f.create(); restarted.taskActivity(to, last);
  await restarted.flushNativeActivity(); assert.equal(f.calls.length, before);
});

test("native activity suppresses legacy progress notices when both are configured", async () => {
  const f = await fixture("tools"); const ch = f.create();
  const input = { ...msg("test"), id: "$input", replyTo: to };
  await ch.turnStatus(to, input, "started");
  ch.turnEvent(to, { type: "tool", phase: "start", name: "bash", callId: "call" }, input);
  ch.turnEvent(to, { type: "tool", phase: "end", name: "bash", callId: "call" }, input);
  await ch.turnStatus(to, input, "completed");
  await ch.stop(1000);
  assert.equal(f.calls.length, 0, "legacy tool progress must not send separate chat lines");
});

test("Matrix restart closes a persisted in-flight tool with the original event reference", async () => {
  const f = await fixture(); const ch = f.create();
  const activity = new TurnActivity({ id: "crashed-turn", role: "main", context: "operator" }, event => ch.taskActivity(to, event));
  activity.event({ type: "tool", phase: "start", name: "bash", callId: "call" });
  await ch.flushNativeActivity();
  const restarted = f.create(); await restarted.flushNativeActivity();
  assert.ok(f.calls.some(c => c.body["m.new_content"]?.body.endsWith("interrupted (host restart)")));
  activity.finish("cancelled"); await ch.flushNativeActivity();
});

test("Matrix native coalesces bursts and renders only trusted dispatcher state", async () => {
  const f = await fixture(); const ch = f.create();
  for (let i = 0; i < 1000; i++) ch.dispatcherActivity(to, "execution", "waiting for operator");
  await ch.flushNativeActivity();
  assert.equal(f.calls.length, 2); // one stable seed plus its replacement
  assert.equal(f.calls[0]!.body.body, "Dispatcher: waiting for operator");
  ch.dispatcherActivity(to, "execution", "blocked"); await ch.flushNativeActivity();
  assert.equal(f.ids.size, 3); // identical seed transaction, new edit transaction
  ch.dispatcherActivity(to, "execution", "PRIVATE_UNTRUSTED"); await ch.flushNativeActivity();
  assert.ok(!JSON.stringify(f.calls).includes("PRIVATE_UNTRUSTED"));
});

for (const key of ["main", "dispatch:task:claim"]) test(`Harness blocked ${key} delivers actual Matrix liveness without model progress`, async () => {
  const f = await fixture(); const ch = f.create();
  const runtime = new FakeRuntime(); let release!: () => void; let clock = 0;
  const open = runtime.open.bind(runtime);
  runtime.open = async (...args) => { const s = await open(...args); release = runtime.sessions.get(args[0])!.hold(); return s; };
  const harness = new Harness({ runtime, now: () => clock, tickMs: 60000, activity: { intervalMs: 1000, maxAlive: 1 } });
  harness.addChannel(ch); harness.onStateChange = async () => {};
  await harness.accept({ ...msg("PRIVATE_OPERATOR", "operator", key), id: "stable-input", replyTo: to });
  while (!release || !runtime.sessions.get(key)?.busy) await new Promise(resolve => setTimeout(resolve, 1));
  clock = 2000; await new Promise(resolve => setTimeout(resolve, 1050));
  await ch.flushNativeActivity();
  assert.ok(f.calls.some(c => c.body["m.new_content"]?.body.includes("weiterhin aktiv (Host)")));
  assert.equal(runtime.sessions.get(key)!.prompts.length, 1);
  release(); await harness.waitForSessionIdle(key); await ch.flushNativeActivity();
  assert.ok(f.calls.some(c => c.body["m.new_content"]?.body.includes("completed")));
  // FakeRuntime echoes the prompt as its normal final reply; inspect native notices only.
  const notices = f.calls.filter(c => c.body.body?.startsWith("Main ·") || c.body.body?.startsWith("Worker ·") || c.body["m.new_content"]?.body?.startsWith("Main ·") || c.body["m.new_content"]?.body?.startsWith("Worker ·"));
  assert.ok(!JSON.stringify(notices).includes("PRIVATE_OPERATOR"));
});
