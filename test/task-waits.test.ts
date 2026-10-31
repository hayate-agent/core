import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

function fixture() {
  let now = 1000;
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000, now: () => now });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", replyTo: { channel: "mem", target: "room1" }, task: {
    id: "task", original: "Deliver authorized feature", state: "waiting", next: "Read release source and reconcile rollout",
    depth: 2, wait: { reason: "release published", nextAt: 61000, deadline: 301000 },
  } }]);
  return { h, runtime, channel, time: (value: number) => { now = value; } };
}

test("wait survives serialized restart, wakes once with original authority and persists before execution", async () => {
  const f = fixture(); const sessions = JSON.parse(JSON.stringify(f.h.snapshotSessions()));
  await f.h.stop(0);
  let now = 61000; let saved = false;
  const runtime = new FakeRuntime(() => { assert.ok(saved); return "checked"; });
  const h = new Harness({ runtime, tickMs: 60000, now: () => now }); h.addChannel(new MemoryChannel());
  h.restoreSessions(sessions);
  h.onStateChange = async () => { if (h.pendingInputs().some(i => i.id === "wait:task:1")) saved = true; };
  try {
    now = 60000; await h.tick(); assert.equal(runtime.sessions.size, 0);
    now = 61000; await Promise.all([h.tick(), h.tick()]); await h.drained();
    const prompts = runtime.sessions.get("mem:room1")!.prompts;
    assert.equal(prompts.length, 1); assert.match(prompts[0], /Deliver authorized feature/);
    assert.match(prompts[0], /NOT evidence/); assert.match(prompts[0], /release published/);
    await h.tick(); await h.drained(); assert.equal(prompts.length, 1);
  } finally { await h.stop(0); }
});

test("pause, stop, queued operator work and unavailable persistence suppress wait wakeups", async () => {
  for (const mode of ["pause", "stop", "queue", "no-save"] as const) {
    const f = fixture(); f.time(61000);
    try {
      if (mode === "pause") f.h.paused = true;
      if (mode === "stop") await f.h.stopConversation("mem:room1");
      if (mode === "queue") { f.h.paused = true; await f.h.submit(msg("new instruction"), true); }
      if (mode === "no-save") f.h.onStateChange = undefined;
      await f.h.tick(); assert.equal(f.runtime.sessions.size, 0);
      assert.ok(!f.h.pendingInputs().some(i => i.id?.startsWith("wait:")));
    } finally { await f.h.stop(0); }
  }
});

test("expiry and malformed checkpoints retain diagnosis without generic operator chat", async () => {
  for (const malformed of [false, true]) {
    const f = fixture(); f.time(301000);
    if (malformed) f.h.state("mem:room1").task!.depth = -1;
    try {
      await f.h.tick(); await f.h.drained();
      const task = f.h.state("mem:room1").task!;
      assert.equal(task.state, "blocked");
      assert.equal(task.termination, malformed ? "malformed_checkpoint" : "deadline_expired");
      assert.ok(task.next); assert.ok(task.wait);
      assert.equal(f.runtime.sessions.size, 0);
      assert.deepEqual(f.channel.texts(), []);
    } finally { await f.h.stop(0); }
  }
});

test("failed wait checkpoint holds queued recheck and retries without duplication", async () => {
  const f = fixture(); f.time(61000);
  f.h.onStateChange = async () => { throw Error("disk offline"); };
  try {
    await f.h.tick().catch(() => {});
    assert.equal(f.runtime.sessions.size, 0);
    assert.equal(f.h.pendingInputs().filter(i => i.id === "wait:task:1").length, 1);
    f.h.onStateChange = async () => {};
    await f.h.tick(); await f.h.drained();
    assert.equal(f.runtime.sessions.get("mem:room1")?.prompts.length, 1);
    await f.h.tick(); await f.h.drained();
    assert.equal(f.runtime.sessions.get("mem:room1")?.prompts.length, 1);
  } finally { await f.h.stop(0); }
});

for (const verdict of ["continue", "waiting"] as const)
test(`working turn registers bounded wait and rejects unsafe intervals; semantic ${verdict}`, async () => {
  let h: Harness; let assessed = 0; let turns = 0;
  const runtime = new FakeRuntime(() => {
    if (++turns > 1) return "feature delivered";
    assert.throws(() => h.planContinuation("mem:room1", { state: "waiting", next: "check", wait: { reason: "release", retryAfterMs: 1, deadline: 301000 } }));
    h.planContinuation("mem:room1", { state: "waiting", next: "check exact release source", wait: { reason: "new image", retryAfterMs: 60000, deadline: 301000 } });
    return "waiting with wakeup";
  });
  h = new Harness({ runtime, tickMs: 60000, now: () => 1000,
    completionCheck: async () => {
      assessed++;
      return turns === 1 ? { state: verdict, next: "check available release evidence now" } : { state: "completed" };
    } }); h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("deliver feature")); await h.drained();
    const task = h.snapshotSessions()[0].task!;
    assert.equal(task.original, "deliver feature");
    assert.equal(assessed, verdict === "continue" ? 2 : 1, "saved timer must not suppress independent assessment");
    assert.equal(turns, verdict === "continue" ? 2 : 1);
    if (verdict === "continue") {
      assert.equal(task.state, "completed");
      assert.equal(task.wait, undefined, "semantic continuation removes stale WAIT metadata");
      assert.match(runtime.sessions.get("mem:room1")!.prompts[1], /check available release evidence now/);
    } else {
      assert.equal(task.state, "waiting"); assert.equal(task.next, "check exact release source");
      assert.deepEqual(task.wait, { reason: "new image", nextAt: 61000, deadline: 301000 });
    }
  } finally { await h.stop(0); }
});
