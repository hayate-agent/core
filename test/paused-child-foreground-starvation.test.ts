import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, type DurableTask } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

// Characterize the session-wide queue gate without live work or concurrent inference.
test("unrelated restored queue defers paused-child supervision until the session is idle", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pause-foreground-"));
  const store = new ExecutionStore(path.join(dir, "executions.json"));
  await store.load();
  const child = await store.submit("mem:room1", "child", "Inspect deployment", "direct", 1,
    { taskId: "parent", depth: 0, original: "Inspect deployment" });
  const claim = await store.claim(child.id);
  await store.fail(child.id, claim.token!, "runtime-failure");
  let assessments = 0;
  const runtime = new FakeRuntime(() => "Unrelated answer");
  const h = new Harness({ runtime, executionStore: store, now: () => 10000, tickMs: 60000,
    completionCheck: async input => {
      if (input.taskId === "parent") { assessments++; return { state: "blocked" }; }
      return { state: "completed" };
    } });
  h.addChannel(new MemoryChannel());
  h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", replyTo: { channel: "mem", target: "room1" },
    task: { id: "parent", original: "Inspect deployment", state: "waiting", depth: 0 } }]);
  h.restorePending([{ id: "unrelated", source: "api", sessionKey: "mem:room1", text: "Unrelated read-only question",
    replyTo: { channel: "mem", target: "room1" } }]);
  const before = JSON.stringify(store.list());
  try {
    for (let i = 0; i < 20; i++) await h.tick();
    assert.equal(assessments, 0, "a retained unrelated queue gates all 20 supervision ticks");
    assert.equal(runtime.opened.length, 0, "restored foreground work must not execute before release");
    assert.equal(h.pendingInputs().length, 1);
    h.releaseRestored();
    await h.drained();
    await h.tick();
    await h.drained();
    assert.equal(assessments, 1, "assessment becomes reachable after unrelated work drains");
    assert.equal(JSON.stringify(store.list()), before, "supervision must not resume or mutate the child");
    assert.equal(store.list()[0]!.status, "paused");
  } finally {
    await h.stop(1000);
    await rm(dir, { recursive: true, force: true });
  }
});

for (const hold of ["manual-pause", "operator-stop", "approval", "exhausted", "same-parent"] as const) {
  test(`completed foreground boundary preserves ${hold}`, { timeout: 10000 }, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pause-boundary-hold-"));
    const store = new ExecutionStore(path.join(dir, "executions.json"));
    await store.load();
    const child = await store.submit("mem:room1", "child", "Inspect deployment", "direct", 1,
      { taskId: "parent", depth: 0, original: "Inspect deployment" });
    const claim = await store.claim(child.id);
    if (hold === "manual-pause") await store.control(child.id, "pause");
    else if (hold === "approval") await store.ask(child.id, claim.token!, "Operator approval required");
    else await store.fail(child.id, claim.token!, "runtime-failure");
    let assessments = 0, prompts = 0;
    const committed = deferred();
    const entered = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    const runtime = new FakeRuntime(() => "Read-only answer");
    const open = runtime.open.bind(runtime);
    runtime.open = async (...args) => {
      const session = await open(...args);
      const prompt = session.prompt.bind(session);
      session.prompt = async (...promptArgs) => {
        const i = prompts++;
        entered[i]!.resolve();
        await release[i]!.promise;
        return prompt(...promptArgs);
      };
      return session;
    };
    const h = new Harness({ runtime, executionStore: store, now: () => 10000, tickMs: 60000,
      completionCheck: async input => {
        if (input.taskId === "parent") assessments++;
        return { state: "completed" };
      }, turnCommitted: async input => { if (input.id === "first") committed.resolve(); } });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    const parent: DurableTask = { id: "parent", original: "Inspect deployment", state: "waiting", depth: 0 };
    if (hold === "operator-stop") { parent.state = "stopped"; parent.termination = "operator_stop"; }
    if (hold === "exhausted") {
      parent.recoveryRetry = { attempts: 3, nextAt: 0, diagnostic: "technical" };
      parent.supervisorDecision = { verdict: "blocked", diagnostic: "technical" };
    }
    h.restoreSessions([{ key: "mem:room1", replyTo: { channel: "mem", target: "room1" }, task: parent }]);
    const before = JSON.stringify(store.list());
    try {
      await h.submit({ id: "first", source: "api", sessionKey: "mem:room1", text: "Unrelated first question" });
      await entered[0]!.promise;
      // Keep the successor held so only the completed FIRST boundary is observed.
      h.enqueue({ id: "second", source: "api", sessionKey: "mem:room1", text: "Queued question",
        ...(hold === "same-parent" ? { taskId: "parent" } : {}) });
      release[0]!.resolve();
      if (hold === "same-parent") {
        // A task-bound input may be fenced before inference. Wait for the first
        // turn's durable commit instead of requiring that fenced work to run.
        await committed.promise;
      } else await entered[1]!.promise;
      assert.equal(assessments, 0, "the completed boundary must not bypass the hold");
      assert.equal(JSON.stringify(store.list()), before, "no child execution effect is changed");
      if (hold === "exhausted") assert.equal(h.state("mem:room1").task?.recoveryRetry?.attempts, 3);
      if (hold === "operator-stop") assert.equal(h.state("mem:room1").task?.state, "stopped");
    } finally {
      for (const gate of release) gate.resolve();
      await h.stop(1000);
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// Each prompt is held until its successor is durably queued. This exercises real
// completed turns, not just a restored inbox that has never been released.
test("paused-child assessment runs at a completed foreground boundary despite a continuous unrelated queue", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pause-boundaries-"));
  const store = new ExecutionStore(path.join(dir, "executions.json"));
  await store.load();
  const child = await store.submit("mem:room1", "child", "Inspect deployment", "direct", 1,
    { taskId: "parent", depth: 0, original: "Inspect deployment" });
  const claim = await store.claim(child.id);
  await store.fail(child.id, claim.token!, "runtime-failure");
  const count = 20;
  const entered = Array.from({ length: count }, deferred);
  const release = Array.from({ length: count }, deferred);
  let starts = 0, completions = 0, assessments = 0, active = 0, maxActive = 0;
  const runtime = new FakeRuntime(() => "Unrelated answer");
  const open = runtime.open.bind(runtime);
  runtime.open = async (...args) => {
    const session = await open(...args);
    const prompt = session.prompt.bind(session);
    session.prompt = async (...promptArgs) => {
      const index = starts++;
      active++; maxActive = Math.max(maxActive, active);
      entered[index]!.resolve();
      try { await release[index]!.promise; return await prompt(...promptArgs); }
      finally { active--; completions++; }
    };
    return session;
  };
  const h = new Harness({ runtime, executionStore: store, now: () => 10000, tickMs: 60000,
    completionCheck: async input => {
      if (input.taskId === "parent") {
        assert.equal(active, 0, "assessment must not overlap foreground inference");
        assessments++; return { state: "blocked" };
      }
      return { state: "completed" };
    } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", replyTo: { channel: "mem", target: "room1" },
    task: { id: "parent", original: "Inspect deployment", state: "waiting", depth: 0 } }]);
  const before = JSON.stringify(store.list());
  const submit = (i: number) => h.submit({ id: `foreground-${i}`, source: "api", sessionKey: "mem:room1",
    text: `Unrelated read-only question ${i}`, replyTo: { channel: "mem", target: "room1" } });
  try {
    await submit(0);
    for (let i = 0; i < count; i++) {
      await entered[i]!.promise;
      assert.equal(completions, i, "each previous foreground turn completed before its successor started");
      assert.equal(assessments, i === 0 ? 0 : 1, "the first completed boundary assesses once before the queued successor");
      if (i + 1 < count) await submit(i + 1);
      await h.tick();
      assert.equal(assessments, i === 0 ? 0 : 1, "a tick must not add assessments while foreground inference is active");
      release[i]!.resolve();
    }
    await h.drained();
    assert.equal(completions, count);
    assert.equal(assessments, 1, "busy turn boundaries supervise the waiting parent without repeating a settled hold");
    await h.tick(); await h.drained();
    assert.equal(assessments, 1, "an idle tick does not repeat the boundary assessment");
    assert.equal(maxActive, 1, "foreground inference stays serialized");
    assert.equal(JSON.stringify(store.list()), before, "no child resume or changed execution effects");
  } finally {
    for (const gate of release) gate.resolve();
    await h.stop(1000);
    await rm(dir, { recursive: true, force: true });
  }
});
