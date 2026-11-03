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
import type { Address, Inbound } from "../src/types.js";

test("worker activity uses current claim and synthetic parent envelope without prompting", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "worker-activity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "ledger.json")); await store.load();
  const runtime = new FakeRuntime(); const harness = new Harness({ runtime, tickMs: 60000 });
  const channel = new MemoryChannel(); const seen: Array<{ to: Address; event: ActivityEvent; input: Inbound }> = [];
  Object.assign(channel, { taskActivity: (to: Address, event: ActivityEvent, input: Inbound) => seen.push({ to, event, input }) });
  harness.addChannel(channel);
  harness.home = { channel: "mem", target: "room" };
  harness.state("parent").replyTo = { channel: "mem", target: "unrelated" };
  const original = { channel: "mem", target: "room", thread: "appointment-A" };
  const task = await store.submit("parent", "r", "PRIVATE TASK", "direct", 1, {
    taskId: "appointment", original: "PRIVATE TASK", depth: 0,
    anchor: { id: "A", task: "PRIVATE TASK", receivedAt: 1, replyTo: original, outputTags: ["appointments"] },
  });
  const claim = await store.claim(task.id); const key = `${task.id}:${claim.token}`;
  const bridge = new DispatcherRuntime(harness, store);
  const event: ActivityEvent = { type: "activity", kind: "alive", snapshot: { id: "turn-hash", role: "worker", context: "worker", phase: "running", activity: "runtime active", tools: [], elapsedMs: 1000, inactiveMs: 1000 } };
  const input: Inbound = { sessionKey: `dispatch:${key}`, source: "api", text: "PRIVATE TASK" };
  const emit = (target = key, envelope = input) => bridge.channel.taskActivity!({ channel: "dispatch", target }, event, envelope);
  bridge.channel.turnEvent!({ channel: "dispatch", target: key }, { type: "execution", selection: { model: "p/actual", thinking: "off" } }, input);
  // Serialize behind the asynchronous observation without relying on a display sink.
  await store.checkpoint(task.id, claim.token!, "observed");
  assert.deepEqual(store.list("parent")[0].execution, { model: "p/actual", thinking: "off" });
  bridge.channel.turnEvent!({ channel: "dispatch", target: `${task.id}:obsolete` }, { type: "execution", selection: { model: "bad" } }, input);
  await store.checkpoint(task.id, claim.token!, "still observed");
  assert.equal(store.list("parent")[0].execution?.model, "p/actual");
  emit();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].input.text, ""); assert.equal(seen[0].input.sessionKey, "parent");
  assert.equal(seen[0].event.snapshot.parent, task.id);
  assert.deepEqual(seen[0].to, original);
  assert.deepEqual(seen[0].input.replyTo, original);
  assert.deepEqual(seen[0].event.snapshot.outputTags, ["appointments"]);
  assert.deepEqual(bridge.approvalTarget(input.sessionKey), original);
  assert.equal(bridge.approvalTarget(`dispatch:${task.id}:obsolete`), undefined);
  assert.equal(event.snapshot.parent, undefined);
  assert.equal(runtime.opened.length, 0); assert.equal(harness.pendingInputs().length, 0);
  emit(`${task.id}:obsolete`); emit(key, { ...input, sessionKey: "other" });
  assert.equal(seen.length, 1);
  // Changed home cannot replace the immutable original address either.
  harness.home = { channel: "subagents", target: "nested" }; emit();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].to, original);
  harness.home = { channel: "mem", target: "room" };
  Object.assign(channel, { taskActivity: () => { throw Error("transport offline"); } });
  assert.doesNotThrow(() => emit());
  await store.cancelParent("parent"); emit();
  assert.equal(seen.length, 2);
  assert.equal(bridge.approvalTarget(input.sessionKey), undefined);
  // Preserve the legacy no-anchor internal-channel guard coverage.
  const legacy = await store.submit("legacy", "r", "legacy", "direct");
  const legacyClaim = await store.claim(legacy.id);
  const legacyKey = `${legacy.id}:${legacyClaim.token}`;
  Object.assign(channel, { taskActivity: (to: Address, event: ActivityEvent, input: Inbound) => seen.push({ to, event, input }) });
  for (const internal of ["dispatch", "subagents"]) {
    harness.home = { channel: internal, target: "nested" };
    emit(legacyKey, { ...input, sessionKey: `dispatch:${legacyKey}` });
    assert.equal(bridge.approvalTarget(`dispatch:${legacyKey}`), undefined);
  }
  assert.equal(seen.length, 2);
});
