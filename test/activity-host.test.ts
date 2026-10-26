import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { ActivityEvent } from "../src/activity.js";

for (const key of ["main", "dispatch:task:claim"]) test(`native liveness during blocked ${key} prompt without extra model calls`, async () => {
  let clock = 0;
  const runtime = new FakeRuntime();
  let release!: () => void;
  const open = runtime.open.bind(runtime);
  runtime.open = async (...args) => { const session = await open(...args); release = runtime.sessions.get(args[0])!.hold(); return session; };
  const channel = new MemoryChannel();
  const events: ActivityEvent[] = [];
  Object.assign(channel, { taskActivity: (_to: unknown, event: ActivityEvent) => events.push(event) });
  const harness = new Harness({ runtime, now: () => clock, activity: { intervalMs: 1000, maxAlive: 1 }, tickMs: 60000, busyMode: "queue" });
  harness.addChannel(channel);
  harness.onStateChange = async () => {};
  await harness.accept({ ...msg("private operator text", "operator", key), id: "durable-input" });
  while (!release || !runtime.sessions.get(key)?.busy) await new Promise(resolve => setTimeout(resolve, 1));
  clock = 2000;
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.equal(events.filter(e => e.kind === "alive").length, 1);
  assert.equal(events.at(-1)?.snapshot.role, key === "main" ? "main" : "worker");
  assert.equal(runtime.sessions.get(key)!.prompts.length, 1);
  release(); await harness.waitForSessionIdle(key);
  assert.equal(events.at(-1)?.snapshot.phase, "completed");
  assert.ok(!JSON.stringify(events).includes("private operator text"));
});
