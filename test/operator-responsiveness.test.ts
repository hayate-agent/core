import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";
import type { Inbound } from "../src/types.js";

const key = "mem:room1";
const host = (id: string): Inbound => ({ id, sessionKey: key, source: "host", text: id,
  hostEvent: { executionId: id }, replyTo: ROOM, progressId: `progress:${id}` });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

for (const busyMode of ["queue", "steer", "interrupt"] as const) {
  test(`${busyMode}: slow host yields to durable question while dispatcher child remains running`, { timeout: 5000 }, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "operator-yield-"));
    const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
    const workerEntered = gate(), workerRelease = gate(), workerResult = gate();
    let workerSignal!: AbortSignal;
    const runtime = new FakeRuntime();
    const committed: string[] = [];
    const harness = new Harness({ runtime, busyMode, tickMs: 60000, hostEventAllowed: () => true,
      turnCommitted: async input => { committed.push(input.text); },
    });
    const ch = new MemoryChannel(); harness.addChannel(ch);
    const dispatcher = new Dispatcher(store, { name: "held", version: 1, replaySafe: false,
      execute: async (_task, context) => {
        workerSignal = context.signal; workerEntered.resolve();
        await workerRelease.promise;
        return "worker finished";
      },
    }, 1, async event => {
      if (event.type !== "result") return;
      await harness.accept(host(event.executionId)); workerResult.resolve();
    }, () => {});
    t.after(async () => { workerRelease.resolve(); await dispatcher.stop(); await harness.stop(1000); await rm(home, { recursive: true, force: true }); });
    await dispatcher.start();
    const child = await dispatcher.submit(key, "child", "independent work");
    await workerEntered.promise; // submit returned although execute is still blocked
    await harness.sessionFor(key);
    const session = runtime.sessions.get(key)!;
    const entered = gate(), steered = gate(), finish = gate();
    let active = 0, sideEffects = 0;
    session.prompt = async text => {
      assert.equal(++active, 1, "never concurrent prompts on one session");
      session.prompts.push(text);
      try {
        if (text === "slow-result") {
          sideEffects++; entered.resolve();
          await steered.promise; // a real runtime consumes steer at its next safe boundary
          await finish.promise;
          return "direct answer";
        }
        return `processed ${text}`;
      } finally { active--; }
    };
    let saved: Inbound[] = [];
    harness.onStateChange = async () => { saved = structuredClone(harness.pendingInputs()); };
    session.steer = async text => {
      assert.ok(saved.some(input => input.text === text), "durable before injection");
      assert.equal(harness.sessions.get(key)!.current!.source, "host");
      assert.deepEqual(harness.sessions.get(key)!.current!.hostEvent, { executionId: "slow-result" });
      session.steered.push(text); steered.resolve();
    };
    await harness.accept(host("slow-result")); await entered.promise;
    await harness.accept(host("queued-result"));
    const question = { ...msg("question"), id: "operator", progressId: "operator-progress" };
    await harness.accept(question);
    await steered.promise;
    assert.equal(workerSignal.aborted, false);
    assert.equal(store.list()[0]!.status, "running");
    assert.equal(session.aborted, 0, "interrupt mode must not abort a result/tool turn");
    assert.deepEqual(harness.pendingInputs().map(input => input.text), ["slow-result", "question", "queued-result"]);
    const restartInbox = structuredClone(harness.pendingInputs());
    finish.resolve(); await harness.waitForSessionIdle(key);
    assert.deepEqual(ch.texts(), ["direct answer", "processed queued-result"]);
    assert.equal(ch.sent[0]!.meta?.progressId, "operator-progress", "not an edit of stale host progress");
    assert.equal(sideEffects, 1);
    assert.deepEqual(committed, ["slow-result", "queued-result"]);
    assert.equal(workerSignal.aborted, false);
    workerRelease.resolve(); await workerResult.promise; await harness.waitForSessionIdle(key);
    assert.equal(committed.filter(text => text === child.id).length, 1);
    assert.equal(harness.pendingInputs().length, 0);

    // Crash snapshot retains the result provenance AND the operator input. Queue
    // priority on restart answers the question before replayable background work.
    const restoredRuntime = new FakeRuntime();
    const restored = new Harness({ runtime: restoredRuntime, busyMode, tickMs: 60000, hostEventAllowed: () => true });
    restored.addChannel(new MemoryChannel());
    restored.onStateChange = async () => {};
    restored.restorePending(restartInbox); restored.releaseRestored();
    await restored.waitForSessionIdle(key);
    assert.deepEqual(restoredRuntime.sessions.get(key)!.prompts, ["question", "slow-result", "queued-result"]);
    assert.deepEqual(restored.pendingInputs(), []);
    await restored.stop(1000);
  });
}

test("restored foreground inputs retain FIFO ahead of result and continuation work", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, busyMode: "queue", tickMs: 60000, hostEventAllowed: () => true });
  harness.addChannel(new MemoryChannel());
  harness.onStateChange = async () => {};
  harness.restorePending([host("result"), { sessionKey: key, source: "heartbeat", text: "persisted wait" },
    { ...msg("first"), id: "first" }, { ...msg("second"), id: "second" }]);
  harness.releaseRestored(); await harness.waitForSessionIdle(key);
  assert.deepEqual(runtime.sessions.get(key)!.prompts, ["first", "second", "result", "persisted wait"]);
  await harness.stop(1000);
});

test("failed background steering queues question before other results without abort/replay", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, busyMode: "interrupt", tickMs: 60000, hostEventAllowed: () => true });
  harness.addChannel(new MemoryChannel());
  harness.onStateChange = async () => {};
  await harness.sessionFor(key);
  const session = runtime.sessions.get(key)!;
  const release = session.hold();
  session.steer = async () => { throw Error("not supported"); };
  await harness.accept(host("current"));
  await new Promise(resolve => setImmediate(resolve));
  await harness.accept(host("queued"));
  await harness.accept({ ...msg("question"), id: "question" });
  assert.equal(session.aborted, 0);
  release(); await harness.waitForSessionIdle(key);
  assert.deepEqual(session.prompts, ["current", "question", "queued"]);
  await harness.stop(1000);
});
