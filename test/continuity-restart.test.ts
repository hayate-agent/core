import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "mem:room1";
const retained = (): DurableTask => ({ id: "retained", original: "Verify actual deployment; deliver result without repeating deployment", state: "active", depth: 2 });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

// Snapshot at the actual persisted decision / not-yet-admitted inbox boundary.
async function decisionSnapshot() {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000,
    completionCheck: async () => ({ state: "continue", next: "Inspect the already completed deployment" }) });
  h.restoreSessions([{ key, task: retained() }]);
  let saved: ReturnType<Harness["snapshotSessions"]> = [];
  h.onStateChange = async () => { saved = clone(h.snapshotSessions()); };
  try {
    const state = h.state(key);
    await (h as unknown as { assessStartupTask(s: typeof state, t: DurableTask): Promise<void> }).assessStartupTask(state, state.task!);
    assert.equal(h.pendingInputs().length, 0);
    assert.equal(saved[0].task?.recoveryAssessment, "decided");
    assert.equal(saved[0].task?.recoveryAdmission?.id, "task:retained:3");
    return saved;
  } finally { await h.stop(0); }
}

test("persisted decision recovers admission after crash; tick/drain and second restart do not replay completed work", async () => {
  const snapshot = await decisionSnapshot();
  let prompts = 0, checks = 0;
  const runtime = new FakeRuntime(() => { prompts++; h.planContinuation(key, { state: "completed" }); return "Verified completed deployment"; });
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => { checks++; return undefined; } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions(snapshot);
  try {
    await h.tick(); await h.drained();
    assert.equal(prompts, 1); assert.equal(checks, 1); // turn end only, never repeats startup inference
    assert.equal(h.snapshotSessions()[0].task?.depth, 3);
    const second = new Harness({ runtime, tickMs: 60000 }); second.onStateChange = async () => {};
    second.restoreSessions(clone(h.snapshotSessions())); second.restoreSeen(h.seenIds());
    second.restorePending(clone(h.pendingInputs()));
    try { await second.recoverTasks(); second.releaseRestored(); await second.tick(); await second.drained(); assert.equal(prompts, 1); }
    finally { await second.stop(0); }
  } finally { await h.stop(0); }
});

test("interrupted assessment is durably reconciled once across restart", async () => {
  for (const interrupted of [true]) {
    const t = retained(); if (interrupted) t.recoveryAssessment = "claimed";
    const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
    const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {};
    h.restoreSessions([{ key, task: t, replyTo: { channel: "mem", target: "room1" } }]);
    try {
      await h.recoverTasks();
      const saved = clone(h.snapshotSessions());
      assert.equal(saved[0].task?.state, "active"); assert.match(saved[0].task?.next!, /never replay completed effects/);
      assert.equal(channel.sent.length, 0);
      let turns = 0;
      const second = new Harness({ runtime: new FakeRuntime(() => { turns++; second.planContinuation(key, { state: "completed" }); return "Verified"; }), tickMs: 60000 });
      second.onStateChange = async () => {}; second.addChannel(channel); second.restoreSessions(saved);
      try { await second.tick(); await second.drained(); await second.tick(); await second.drained(); assert.equal(turns, 1); assert.equal(second.state(key).task!.state, "completed"); }
      finally { await second.stop(0); }
    } finally { await h.stop(0); }
  }
});

test("persisted recovery admission cannot revive stopped/completed/paused/expired or externally owned work", async () => {
  const snapshot = await decisionSnapshot();
  for (const mode of ["stopped", "completed", "blocked", "waiting", "paused", "expired", "external"] as const) {
    let prompts = 0;
    const saved = clone(snapshot); const t = saved[0].task!;
    if (["stopped", "completed", "blocked", "waiting"].includes(mode)) t.state = mode as DurableTask["state"];
    if (mode === "expired") t.expiresAt = 100;
    saved[0].tasks = [t];
    const h = new Harness({ runtime: new FakeRuntime(() => { prompts++; return "not allowed"; }), now: () => 100,
      tickMs: 60000, externallyRecoveredSession: () => mode === "external" });
    h.onStateChange = async () => {}; h.restoreSessions(saved); if (mode === "paused") h.paused = true;
    try { await h.recoverTasks(); h.releaseRestored(); await h.tick(); if (mode !== "paused") await h.drained(); assert.equal(prompts, 0, mode); }
    finally { await h.stop(0); }
  }
});

test("authority changes during inference and save cannot apply a stale decision; concurrent ticks infer once", async () => {
  for (const mutation of ["original", "depth", "expiry", "stop"] as const) {
    let resolve!: () => void; let entered!: () => void; let checks = 0;
    const started = new Promise<void>(r => { entered = r; }); const held = new Promise<void>(r => { resolve = r; });
    const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, completionCheck: async () => {
      checks++; entered(); await held; return { state: "continue", next: "stale next" };
    } });
    h.onStateChange = async () => {}; h.restoreSessions([{ key, task: retained() }]);
    try {
      const recovering = h.recoverTasks(); await started;
      const concurrent = h.recoverTasks();
      const t = h.state(key).task!;
      if (mutation === "original") t.original = "different authority";
      if (mutation === "depth") t.depth++;
      if (mutation === "expiry") t.expiresAt = 1;
      if (mutation === "stop") await h.stopConversation(key);
      resolve(); await recovering; await concurrent;
      assert.equal(checks, 1); assert.equal(t.next, undefined); assert.equal(t.recoveryAdmission, undefined);
    } finally { resolve(); await h.stop(0); }
  }
});
