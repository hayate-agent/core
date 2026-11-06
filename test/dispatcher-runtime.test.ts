import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { ExecutionStore } from "../src/execution.js";
import { Dispatcher } from "../src/dispatcher.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
function gate() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}
test("recovery after settled direct turn reuses result without another worker", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-gap-"));
  let dispatcher: Dispatcher | undefined;
  t.after(async () => { await dispatcher?.stop(); await rm(home, { recursive: true, force: true }); });
  const file = path.join(home, "ledger.json");
  const store = new ExecutionStore(file); await store.load();
  const task = await store.submit("p", "r", "create external resource", "direct");
  const running = await store.claim(task.id);
  let calls = 0;
  let bridge!: DispatcherRuntime;
  const harness = { accept: async (input: { replyTo: { target: string } }) => {
    calls++;
    await bridge.channel.send({ channel: "dispatch", target: input.replyTo.target }, "created resource 123");
  } } as unknown as Harness;
  bridge = new DispatcherRuntime(harness, store);
  const answer = await bridge.strategy.execute(running, {
    signal: new AbortController().signal,
    intent: (key, replay) => store.intent(task.id, running.token!, key, replay),
    checkpoint: value => store.checkpoint(task.id, running.token!, value),
    settleIntent: (key, result, checkpoint) => store.settleIntent(task.id, running.token!, key, result, checkpoint),
  });
  assert.equal(answer, "created resource 123");
  // Crash boundary: intentionally do not call complete().
  const restored = new ExecutionStore(file); await restored.load();
  assert.equal(restored.list()[0]!.status, "running");
  assert.equal(restored.list()[0]!.intent, undefined);
  const newBridge = new DispatcherRuntime(harness, restored);
  const result = gate();
  dispatcher = new Dispatcher(restored, newBridge.strategy, 1, async event => {
    if (event.type === "result") { assert.equal(event.text, answer); result.resolve(); }
  }, error => { throw error; });
  await dispatcher.start(); await result.promise;
  assert.equal(calls, 1);
  assert.equal(restored.list()[0]!.status, "completed");
});

test("Harness recovery never independently replays ledger-owned worker turns", async () => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, busyMode: "queue",
    externallyRecoveredSession: key => key.startsWith("dispatch:") });
  const input = { id: "old-worker", sessionKey: "dispatch:task:old-token", source: "api" as const, text: "unsafe action", started: true };
  harness.restoreSessions([{ key: input.sessionKey, task: { id: "worker-task", state: "active", original: "unsafe action", next: "repeat action", depth: 0 } } as never]);
  harness.restorePending([input, { id: "operator", sessionKey: "api:operator", source: "api", text: "hello" }]);
  await harness.recoverTasks();
  assert.deepEqual(harness.pendingInputs().map(item => item.id), ["operator"]);
  assert.equal(harness.sessions.get(input.sessionKey)!.queue.length, 0);
});

test("cancelled runtime execution waits for stop and actual pump settlement", async () => {
  const accepted = gate(); const stopEntered = gate(); const stopRelease = gate();
  const idleEntered = gate(); const idleRelease = gate();
  const harness = {
    accept: async () => { accepted.resolve(); },
    stopConversation: async () => { stopEntered.resolve(); await stopRelease.promise; },
    waitForSessionIdle: async () => { idleEntered.resolve(); await idleRelease.promise; },
  } as unknown as Harness;
  const bridge = new DispatcherRuntime(harness, {} as ExecutionStore);
  const abort = new AbortController();
  let settled = false;
  const execution = bridge.strategy.execute({ id: "task", token: "token", input: "work" } as never, {
    signal: abort.signal, intent: async () => {}, checkpoint: async () => {}, settleIntent: async () => {},
  });
  const checked = assert.rejects(execution, /interrupted/).then(() => { settled = true; });
  await accepted.promise; abort.abort(); await stopEntered.promise;
  assert.equal(settled, false);
  stopRelease.resolve(); await idleEntered.promise;
  assert.equal(settled, false);
  idleRelease.resolve(); await checked;
});
