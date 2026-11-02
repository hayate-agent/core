import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "mem:room1";
function setup(depth: number, work: (h: Harness) => Promise<void>, completionCheck?: NonNullable<ConstructorParameters<typeof Harness>[0]["completionCheck"]>) {
  let now = 61000;
  const runtime = new FakeRuntime();
  const open = runtime.open.bind(runtime);
  runtime.open = async (...args) => {
    const session = await open(...args);
    session.prompt = async () => { await work(h); return "NO_REPLY"; };
    return session;
  };
  const channel = new MemoryChannel();
  const h = new Harness({ runtime, now: () => now, completionCheck }); h.addChannel(channel);
  h.onStateChange = async () => {};
  const task: DurableTask = { id: "task", original: "Deliver feature", state: "waiting", next: "Check dispatcher delivery",
    depth, wait: { reason: "delivery running", nextAt: now, deadline: 10000000 } };
  h.restoreSessions([{ key, task }]);
  return { h, runtime, channel, time: (n: number) => { now = n; } };
}
function wait(h: Harness) {
  h.planContinuation(key, { state: "waiting", next: "Check dispatcher delivery", wait: {
    reason: "delivery running", retryAfterMs: 60000, deadline: 10000000,
  } });
}

for (const depth of [19, 20]) test(`unchanged status rechecks at depth ${depth} do not spend productive budget`, async () => {
  const f = setup(depth, async h => {
    await h.guardWaitTool(key, "plugin_dispatch", { action: "status", id: "delivery" });
    await h.guardWaitTool(key, "plugin_task_continuation", { state: "waiting" });
    wait(h);
  });
  try {
    for (let i = 1; i <= 25; i++) {
      f.time(1000 + i * 60000);
      await Promise.all([f.h.tick(), f.h.tick()]); await f.h.drained();
      const task = f.h.state(key).task!;
      assert.equal(task.depth, depth); assert.equal(task.waitChecks, i);
      assert.equal(task.state, "waiting"); assert.equal(task.wait?.deadline, 10000000);
      await f.h.tick(); await f.h.drained();
      assert.equal(task.waitChecks, i, "no polling before interval");
    }
    const sessions = JSON.parse(JSON.stringify(f.h.snapshotSessions()));
    const restarted = new Harness({ runtime: new FakeRuntime(), now: () => 10000000 });
    restarted.restoreSessions(sessions); restarted.onStateChange = async () => {};
    try {
      await restarted.tick(); await restarted.drained();
      assert.equal(restarted.state(key).task!.termination, "deadline_expired");
      assert.equal(restarted.state(key).task!.waitChecks, 25);
      assert.ok(restarted.state(key).task!.next);
    } finally { await restarted.stop(0); }
    assert.deepEqual(f.channel.texts(), []);
  } finally { await f.h.stop(0); }
});

test("productive tool in wait charges once, persists before effect; waiting prose cannot hide it", async () => {
  let effects = 0; let saves = 0;
  const f = setup(19, async h => {
    await h.guardWaitTool(key, "bash", { command: "mutation" });
    assert.ok(saves > 0); assert.equal(h.state(key).task!.depth, 20); effects++;
    await h.guardWaitTool(key, "plugin_dispatch", { action: "submit" });
    assert.equal(h.state(key).task!.depth, 20);
    wait(h);
  });
  f.h.onStateChange = async () => { saves++; };
  try {
    await f.h.tick(); await f.h.drained(); assert.equal(effects, 1);
    f.runtime.sessions.get(key)!.prompt = async () => {
      await assert.rejects(f.h.guardWaitTool(key, "bash", {}), /budget exhausted/);
      await assert.rejects(f.h.guardWaitTool(key, "plugin_dispatch", { action: "submit" }), /budget exhausted/);
      wait(f.h); return "NO_REPLY";
    };
    f.time(121000); await f.h.tick(); await f.h.drained();
    assert.equal(effects, 1); assert.equal(f.h.state(key).task!.depth, 20);
  } finally { await f.h.stop(0); }
});

test("wait to productive continuation spends next step, depth20 retains blocked checkpoint", async () => {
  for (const depth of [19, 20]) {
    let calls = 0;
    const f = setup(depth, async h => {
      calls++;
      h.planContinuation(key, { state: "continue", next: "Perform remaining authorized work" });
    }, async () => calls === 1 ? { state: "continue", next: "Perform remaining authorized work", progress: { advanced: false, fingerprint: "same-step" } } : { state: "blocked" });
    try {
      await f.h.tick(); await f.h.drained();
      const task = f.h.state(key).task!;
      assert.equal(calls, depth === 19 ? 2 : 1);
      assert.equal(task.depth, 20); assert.equal(task.state, "blocked");
      assert.equal(task.termination, "productive_budget_exhausted");
      assert.equal(task.next, "Perform remaining authorized work");
      assert.equal(task.wait?.reason, "delivery running");
    } finally { await f.h.stop(0); }
  }
});

test("failed work-charge save denies effect and can retry; expiry and stop revoke even status", async () => {
  const f = setup(19, async h => {
    h.onStateChange = async () => { throw Error("disk offline"); };
    await assert.rejects(h.guardWaitTool(key, "bash", {}), /disk offline/);
    assert.equal(h.state(key).task!.depth, 19);
    h.onStateChange = async () => {};
    await h.guardWaitTool(key, "bash", {});
    assert.equal(h.state(key).task!.depth, 20);
    f.time(10000000);
    await assert.rejects(h.guardWaitTool(key, "plugin_dispatch", { action: "status" }), /expired/);
    f.time(61000);
    h.state(key).task!.state = "stopped";
    await assert.rejects(h.guardWaitTool(key, "plugin_dispatch", { action: "status" }), /revoked/);
  });
  try { await f.h.tick(); await f.h.drained(); }
  finally { await f.h.stop(0); }
});
