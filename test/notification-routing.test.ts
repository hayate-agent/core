import { confirmNonproductive } from "./fakes.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { attentionRequired, deliverTaskStatus, routineWait } from "../src/notification-routing.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import type { Inbound } from "../src/types.js";
import { FakeRuntime, MemoryChannel, ROOM, msg } from "./fakes.js";

const plan = { replyKind: "routine" as const, state: "waiting" as const, next: "inspect worker", wait: { reason: "worker result", retryAfterMs: 60000, deadline: 900000 } };
const poll = (): Inbound => ({ source: "cron", sessionKey: "mem:room1", text: "poll", taskId: "task", replyTo: ROOM,
  waitRecheck: { reason: "worker result", next: "inspect worker" }, continuation: structuredClone(plan) });

test("routing is structured: unchanged wait only; direct question, host result, blocker, outcome remain answers", () => {
  assert.equal(routineWait(poll()), true);
  for (const source of ["channel", "api", "host"] as const) assert.equal(routineWait({ ...poll(), source }), false);
  assert.equal(routineWait({ ...poll(), continuation: { ...plan, replyKind: undefined } }), false);
  assert.equal(routineWait({ ...poll(), continuation: { ...plan, replyKind: "substantive" } }), false);
  for (const outcome of ["failed", "cancelled"]) assert.equal(routineWait(poll(), outcome), false);
  assert.equal(routineWait({ ...poll(), continuation: { state: "blocked" } }), false);
  assert.equal(routineWait({ ...poll(), continuation: { state: "completed" } }), false);
  assert.equal(routineWait({ ...poll(), continuation: { ...plan, next: "new substantive step" } }), false);
  assert.equal(routineWait({ ...poll(), continuation: undefined }), false);
});

test("unchanged timer replies display one deduplicated status, survive restart; direct question still answers", async () => {
  const runtime = new FakeRuntime(() => { h.planContinuation("mem:room1", plan); return "worker still running, no result"; });
  const channel = new MemoryChannel(); Object.assign(channel, { editableProgress: true });
  let h = new Harness({ completionCheck: confirmNonproductive, runtime, tickMs: 60000, now: () => 1000 }); h.addChannel(channel); h.onStateChange = async () => {};
  try {
    await h.submit(poll()); await h.drained();
    await h.submit(poll()); await h.drained();
    assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].meta?.presentation, "progress");
    assert.match(channel.sent[0].meta?.progressId ?? "", /^native:status:/);
    const saved = h.snapshotSessions(); await h.stop(0);
    h = new Harness({ completionCheck: confirmNonproductive, runtime, tickMs: 60000, now: () => 1000 }); h.addChannel(channel); h.onStateChange = async () => {};
    h.restoreSessions(saved);
    await h.submit(poll()); await h.drained(); assert.equal(channel.sent.length, 1);
    await h.submit(msg("Is the worker still running?")); await h.drained();
    assert.equal(channel.sent.length, 2); assert.equal(channel.sent[1].meta?.presentation, undefined);
  } finally { await h.stop(0); }
});

test("started/recovery progress shares a row; legacy channels receive explicit fallback", async () => {
  const channel = new MemoryChannel(); Object.assign(channel, { editableProgress: true });
  await deliverTaskStatus(channel, ROOM, "worker", "started");
  await deliverTaskStatus(channel, ROOM, "worker", "recovering");
  assert.equal(channel.sent[0].meta?.progressId, channel.sent[1].meta?.progressId);
  const legacy = new MemoryChannel(); await deliverTaskStatus(legacy, ROOM, "worker", "started");
  assert.equal(legacy.sent[0].text, "started"); assert.equal(legacy.sent[0].meta?.presentation, "progress");
  assert.equal(legacy.sent[0].meta?.progressId, undefined);
});

test("actual results and important blockers retain normal durable delivery", async () => {
  for (const state of ["completed", "blocked"] as const) {
    const channel = new MemoryChannel();
    const h = new Harness({ completionCheck: confirmNonproductive, runtime: new FakeRuntime(() => { h.planContinuation("mem:room1", { state }); return `${state}: evidence`; }), tickMs: 60000 });
    h.addChannel(channel); h.onStateChange = async () => {};
    try {
      await h.submit({ ...poll(), continuation: { state } }); await h.drained();
      assert.equal(channel.sent[0].text, `${state}: evidence`);
      assert.equal(channel.sent[0].meta?.presentation, undefined);
    } finally { await h.stop(0); }
  }
});


test("delayed semantic attention is not rewritten as no-user-action after the hold clears", () => {
  const bridge = new DispatcherRuntime({} as never, { list: () => [] } as never);
  const text = bridge.eventText({ id: "e", executionId: "x", parent: "p", type: "status", status: "paused",
    text: "Verified external prerequisite is missing", automaticRetryAt: 123456, requiresAttention: true });
  assert.match(text, /Verified external prerequisite is missing/);
  assert.doesNotMatch(text, /Keine Nutzeraktion erforderlich/);
});

test("queued lifecycle uses event-time state; blockers/questions remain attention messages", () => {
  const event = { id: "event", executionId: "task", parent: "parent", type: "status" as const, text: "started", status: "running" as const };
  assert.equal(attentionRequired(event, "blocked"), false);
  assert.equal(attentionRequired({ ...event, status: "blocked" }, "completed"), true);
  assert.equal(attentionRequired({ ...event, type: "question" }, "running"), true);
  assert.equal(attentionRequired({ ...event, status: undefined }, "blocked"), true);
  assert.equal(attentionRequired({ ...event, status: "paused", automaticRetryAt: 123456 }, "paused"), false,
    "a host-scheduled recovery is routine status, not a request for another human nudge");
  assert.equal(attentionRequired({ ...event, status: "paused", automaticRetryAt: 123456, requiresAttention: true }, "paused"), true,
    "a real external hold stays actionable while the dispatcher schedules reassessment");
  assert.equal(attentionRequired({ ...event, type: "question", automaticRetryAt: 123456 }, "paused"), true,
    "an actual question still requires an answer");
});
