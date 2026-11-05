import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, ROOM } from "./fakes.js";
import type { ActivityEvent } from "../src/activity.js";
import type { Inbound } from "../src/types.js";

test("worker activity routes with the exact originating input anchor, never the worker input", async t => {
  const home = await mkdtemp(path.join(tmpdir(), "activity-anchor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const anchor = (id: string) => ({ id, task: "original", receivedAt: 1, replyTo: ROOM, outputTags: ["alpha"] });
  const a = await store.submit("parent", "a", "A", "direct", 1, { taskId: "ta", depth: 0, original: "A", anchor: anchor("origin-a") });
  const b = await store.submit("parent", "b", "B", "direct", 1, { taskId: "tb", depth: 0, original: "B", anchor: anchor("origin-b") });
  const legacy = await store.submit("parent", "c", "C", "direct", 1, { taskId: "tc", depth: 0, original: "C" });
  const claims = new Map([[a.id, await store.claim(a.id)], [b.id, await store.claim(b.id)], [legacy.id, await store.claim(legacy.id)]]);
  const h = new Harness({ runtime: new FakeRuntime() }); h.home = ROOM; h.state("parent").replyTo = ROOM;
  const seen: Array<{ event: ActivityEvent; input: Inbound }> = [];
  h.addChannel(Object.assign(new MemoryChannel(), { taskActivity: (_to: unknown, event: ActivityEvent, input: Inbound) => { seen.push({ event, input }); } }));
  const bridge = new DispatcherRuntime(h, store);
  for (const task of [a, b, legacy]) {
    const claim = claims.get(task.id)!;
    bridge.channel.taskActivity!({ channel: "dispatch", target: `${task.id}:${claim.token}` },
      { type: "activity", kind: "progress", snapshot: { id: "w", role: "worker", context: "worker", phase: "running", activity: "runtime active", tools: [], elapsedMs: 0, inactiveMs: 0 } },
      { sessionKey: `dispatch:${task.id}:${claim.token}`, source: "host", text: "SECRET", completionAnchor: anchor("spoofed") });
  }
  assert.deepEqual(seen.map(s => s.input.completionAnchor?.id), ["origin-a", "origin-b", undefined]);
  assert.ok(seen.every(s => s.input.text === "" && s.input.sessionKey === "parent" && !s.input.completionAnchor?.task && !s.input.completionAnchor?.outputTags), "id only, no prose/tags");
});
