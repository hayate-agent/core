import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import type { ActivityEvent } from "../src/activity.js";
import type { Inbound } from "../src/types.js";

test("worker activity uses current claim and synthetic parent envelope without prompting", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "worker-activity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "ledger.json")); await store.load();
  const runtime = new FakeRuntime(); const harness = new Harness({ runtime, tickMs: 60000 });
  const channel = new MemoryChannel(); const seen: Array<{ event: ActivityEvent; input: Inbound }> = [];
  Object.assign(channel, { taskActivity: (_to: unknown, event: ActivityEvent, input: Inbound) => seen.push({ event, input }) });
  harness.addChannel(channel);
  harness.state("parent").replyTo = { channel: "mem", target: "room" };
  const task = await store.submit("parent", "r", "PRIVATE TASK", "direct");
  const claim = await store.claim(task.id); const key = `${task.id}:${claim.token}`;
  const bridge = new DispatcherRuntime(harness, store);
  const event: ActivityEvent = { type: "activity", kind: "alive", snapshot: { id: "turn-hash", role: "worker", context: "worker", phase: "running", activity: "runtime active", tools: [], elapsedMs: 1000, inactiveMs: 1000 } };
  const input: Inbound = { sessionKey: `dispatch:${key}`, source: "api", text: "PRIVATE TASK" };
  const emit = (target = key, envelope = input) => bridge.channel.taskActivity!({ channel: "dispatch", target }, event, envelope);
  emit();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input.text, ""); assert.equal(seen[0].input.sessionKey, "parent");
  assert.equal(seen[0].event.snapshot.parent, `task-${task.id.slice(0, 8)}`);
  assert.equal(event.snapshot.parent, undefined);
  assert.equal(runtime.opened.length, 0); assert.equal(harness.pendingInputs().length, 0);
  emit(`${task.id}:obsolete`); emit(key, { ...input, sessionKey: "other" });
  assert.equal(seen.length, 1);
  for (const internal of ["dispatch", "subagents"]) {
    harness.state("parent").replyTo = { channel: internal, target: "nested" }; emit();
  }
  assert.equal(seen.length, 1);
  harness.state("parent").replyTo = { channel: "mem", target: "room" };
  Object.assign(channel, { taskActivity: () => { throw Error("transport offline"); } });
  assert.doesNotThrow(() => emit());
  await store.cancelParent("parent"); emit();
  assert.equal(seen.length, 1);
});
