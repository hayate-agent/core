import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import type { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";

const key = "mem:room1";
const task = (): DurableTask => ({ id: "retained", original: "Verify existing deployment, do not deploy again", state: "active", depth: 2 });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

test("transient assessment survives real tick/snapshot/restore and admits exactly one reconciliation", async () => {
  let now = 1000, calls = 0, turns = 0;
  const effects = 1;
  const channel = new MemoryChannel();
  const runtime = new FakeRuntime(text => {
    turns++;
    assert.match(text, /First reconcile/);
    assert.equal(effects, 1); // the deployment predates the lost checkpoint
    return "Existing deployment verified; no effect repeated";
  });
  const opts = { runtime, tickMs: 60000, now: () => now, completionCheck: async () => {
    calls++;
    if (calls === 1) throw Error("transient provider failure");
    return calls === 2 ? { state: "continue" as const, next: "Inspect actual deployment evidence only" } : undefined;
  } };
  const first = new Harness(opts); first.addChannel(channel);
  let saved: ReturnType<Harness["snapshotSessions"]> = [];
  first.restoreSessions([{ key, task: task(), replyTo: { channel: "mem", target: "room1" } }]);
  first.onStateChange = async () => { saved = clone(first.snapshotSessions()); };
  try {
    await first.tick(); await first.drained();
    assert.equal(first.state(key).task?.state, "active");
    assert.equal(channel.sent.length, 0); assert.equal(calls, 1); assert.equal(turns, 0);
    await first.tick(); assert.equal(calls, 1, "backoff, not an immediate nudge loop");
    const second = new Harness(opts); second.addChannel(channel); second.restoreSessions(saved);
    second.onStateChange = async () => {};
    try {
      await second.tick(); assert.equal(calls, 1, "backoff survives restart");
      now += 60000;
      await Promise.all([second.tick(), second.tick()]); await second.drained();
      assert.equal(turns, 1); assert.equal(effects, 1); assert.equal(second.state(key).task?.depth, 3);
      const third = new Harness(opts); third.onStateChange = async () => {};
      third.restoreSessions(clone(second.snapshotSessions())); third.restoreSeen(second.seenIds());
      third.restorePending(clone(second.pendingInputs()));
      try { now += 60000; await third.tick(); await third.drained(); assert.equal(turns, 1); }
      finally { await third.stop(0); }
    } finally { await second.stop(0); }
  } finally { await first.stop(0); }
});

test("unusable assessments exhaust persisted bounded attempts and admit reconciliation once", async () => {
  let now = 1000, calls = 0;
  const channel = new MemoryChannel();
  let saved: ReturnType<Harness["snapshotSessions"]> = [{ key, task: task(), replyTo: { channel: "mem", target: "room1" } }];
  for (let restart = 0; restart < 5; restart++) {
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000, now: () => now, completionCheck: async () => { calls++; return undefined; } });
    h.addChannel(channel); h.restoreSessions(saved);
    h.onStateChange = async () => { saved = clone(h.snapshotSessions()); };
    try {
      await h.recoverTasks();
      saved = clone(h.snapshotSessions());
      assert.equal(runtime.sessions.size, 0); assert.equal(h.state(key).task?.depth, 2);
      assert.equal(h.state(key).task?.state, "active");
      assert.equal(h.pendingInputs().length, restart < 2 ? 0 : 1);
    } finally { await h.stop(0); }
    now += 60000;
  }
  assert.equal(calls, 3); assert.equal(channel.sent.length, 0);
});

test("a persisted interrupted claim retries only after backoff and retains its attempt budget", async () => {
  let now = 1000, calls = 0;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const held = new Promise<void>(r => { release = r; });
  const first = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, now: () => now,
    completionCheck: async () => { entered(); await held; return undefined; } });
  first.restoreSessions([{ key, task: task() }]);
  let saved: ReturnType<Harness["snapshotSessions"]> = [];
  first.onStateChange = async () => { saved = clone(first.snapshotSessions()); };
  const pending = first.recoverTasks(); await started;
  const next = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, now: () => now,
    completionCheck: async () => { calls++; return undefined; } });
  next.restoreSessions(saved); next.onStateChange = async () => {};
  try {
    await next.recoverTasks(); assert.equal(calls, 0);
    now += 60000; await next.recoverTasks(); assert.equal(calls, 1); assert.equal(next.state(key).task?.state, "active");
    now += 60000; await next.recoverTasks(); assert.equal(calls, 2); assert.equal(next.state(key).task?.state, "active");
    assert.equal(next.pendingInputs().length, 1);
  } finally { release(); await pending; await first.stop(0); await next.stop(0); }
});

test("retry cannot bypass revoked authority, pending dependencies or stale concurrent results", async () => {
  for (const mode of ["paused", "stopped", "blocked", "completed", "waiting", "expiry", "dependency", "cancel", "anchor", "depth"] as const) {
    let now = 1000, calls = 0, child = false;
    const runtime = new FakeRuntime();
    const store = { list: () => child ? [{ id: "child", status: "running" }] : [] } as unknown as ExecutionStore;
    const h = new Harness({ runtime, executionStore: store, tickMs: 60000, now: () => now,
      completionCheck: async () => { calls++; return undefined; } });
    h.restoreSessions([{ key, task: task() }]); h.onStateChange = async () => {};
    try {
      await h.tick();
      const t = h.state(key).task!;
      if (["stopped", "blocked", "completed", "waiting"].includes(mode)) t.state = mode as DurableTask["state"];
      if (mode === "paused") h.paused = true;
      if (mode === "expiry") t.expiresAt = now + 1;
      if (mode === "dependency") child = true;
      if (mode === "cancel") await h.stopConversation(key);
      if (mode === "anchor") t.anchor = { id: "other", task: "proposal only", receivedAt: 1 };
      if (mode === "depth") t.depth = 20;
      now += 60000; await Promise.all([h.tick(), h.tick()]);
      assert.equal(calls, 1, mode); assert.equal(runtime.sessions.size, 0, mode);
    } finally { await h.stop(0); }
  }
});


test("real handover and compaction preserve retry authority across serialized restart", async () => {
  for (const action of ["handover", "compact"] as const) {
    const home = await mkdtemp(path.join(os.tmpdir(), "bounded-lifecycle-"));
    let now = 1000, calls = 0, turns = 0;
    const runtime = new FakeRuntime(() => { turns++; return "Verified without repeating effects"; });
    const open = runtime.open.bind(runtime);
    runtime.open = async (key, options) => {
      const session = await open(key, options);
      Object.assign(session, { archiveEntries: () => [], summarize: async () => "Existing effect completed, verification pending",
        seedHandover: async () => {} });
      return session;
    };
    const maintenance = new ContextMaintenance(home, () => contextPolicy({ enabled: false, autoHandover: false }));
    const opts = { runtime, tickMs: 60000, now: () => now, contextMaintenance: maintenance,
      completionCheck: async () => { calls++; return calls === 2 ? { state: "continue" as const, next: "Inspect existing effect" } : undefined; } };
    const h = new Harness(opts); h.restoreSessions([{ key, task: task() }]); h.onStateChange = async () => {};
    try {
      await h.tick(); await h.drained(); assert.equal(calls, 1);
      if (action === "handover") assert.match(await h.handover(key, "Verify existing effects only"), /Neue Sitzung/);
      else {
        h.state(key).session = await runtime.open(key);
        await maintenance.admit(key, "compact-retry", { action: "compact", preserve: "Effect already completed", resume: "Verification only" });
        assert.equal(await h.maintainIdle(key), "processed");
        assert.equal(runtime.sessions.get(key)?.compacted, 1);
      }
      assert.equal(turns, 0);
      const restored = new Harness(opts); restored.restoreSessions(clone(h.snapshotSessions())); restored.onStateChange = async () => {};
      try { now += 60000; await restored.tick(); await restored.drained(); assert.equal(turns, 1); assert.equal(restored.state(key).task?.depth, 3); }
      finally { await restored.stop(0); }
    } finally { await h.stop(0); await rm(home, { recursive: true, force: true }); }
  }
});
