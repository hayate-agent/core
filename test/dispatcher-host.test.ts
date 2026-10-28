import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { Dispatcher, stopDispatcherParent } from "../src/dispatcher.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import { replayable } from "../src/delivery/inbox.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import type { Inbound } from "../src/types.js";

function host(id = "event"): Inbound {
  return { id, sessionKey: "parent", text: "/not-a-command", source: "host", hostEvent: { executionId: "task" } };
}

test("parent stop while dispatcher is disabled survives restart and re-enabling", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-disabled-stop-"));
  const file = path.join(home, "ledger.json");
  let dispatcher: Dispatcher | undefined;
  t.after(async () => { await dispatcher?.stop(); await rm(home, { recursive: true, force: true }); });
  const store = new ExecutionStore(file); await store.load();
  const ready = await store.submit("parent", "ready", "work", "direct");
  const paused = await store.submit("parent", "paused", "work", "direct"); await store.control(paused.id, "pause");
  const done = await store.submit("parent", "done", "work", "direct");
  const claimed = await store.claim(done.id); await store.complete(done.id, claimed.token!, "old result");
  const other = await store.submit("other", "ready", "other work", "direct");
  const disabledStore = new ExecutionStore(file); await disabledStore.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, busyMode: "queue",
    conversationStopped: key => stopDispatcherParent(disabledStore, key),
  });
  harness.onStateChange = async () => {};
  await harness.stopConversation("parent");
  const restored = new ExecutionStore(file); await restored.load();
  assert.equal(restored.events().some(event => event.parent === "parent"), false);
  assert.ok(restored.list("parent").every(task => task.parentStopped));
  assert.equal(restored.list().find(task => task.id === ready.id)!.status, "cancelled");
  assert.equal(restored.list().find(task => task.id === paused.id)!.status, "cancelled");
  let completed!: () => void; const finished = new Promise<void>(resolve => { completed = resolve; });
  const executed: string[] = []; const delivered: string[] = [];
  dispatcher = new Dispatcher(restored, { name: "direct", version: 1, replaySafe: false,
    execute: async task => { executed.push(task.id); return "other result"; },
  }, 1, async event => { delivered.push(event.parent); if (event.type === "result") completed(); }, () => {});
  await dispatcher.start(); await finished;
  assert.deepEqual(executed, [other.id]);
  assert.ok(delivered.every(parent => parent === "other"));
});

test("host results without a stored mandate are data, never commands or continuation authority", async () => {
  const runtime = new FakeRuntime();
  let commands = 0; let assessments = 0; let saves = 0;
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", hostEventAllowed: () => true,
    completionCheck: async () => { assessments++; return { state: "continue", next: "unauthorized" }; },
    beforeTurn: async input => { if (input.source === "host") assert.throws(() => harness.planContinuation(input.sessionKey, { state: "continue", next: "unauthorized" }), /No live parent mandate/); },
  });
  harness.commandHandler = async () => { commands++; return true; };
  harness.onStateChange = async () => { saves++; };
  assert.equal(replayable(host()), true);
  await harness.accept(host()); await harness.waitForSessionIdle("parent");
  assert.equal(runtime.sessions.get("parent")!.prompts.length, 1);
  assert.equal(commands, 0); assert.equal(assessments, 0); assert.ok(saves > 0);
  assert.equal(harness.sessions.get("parent")!.task, undefined);
});

test("restored result authority is checked again before execution", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", hostEventAllowed: () => false });
  harness.restorePending([host()]);
  assert.equal(harness.pendingInputs().length, 1);
  harness.releaseRestored(); await harness.waitForSessionIdle("parent");
  assert.equal(runtime.opened.length, 0);
  assert.equal(harness.pendingInputs().length, 0);
});

test("host event revocation during asynchronous setup prevents the model call", async () => {
  const runtime = new FakeRuntime();
  let allowed = true;
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", hostEventAllowed: () => allowed,
    beforeTurn: async () => { allowed = false; },
  });
  harness.onStateChange = async () => {};
  await harness.accept(host()); await harness.waitForSessionIdle("parent");
  assert.equal(runtime.sessions.get("parent")?.prompts.length ?? 0, 0);
});

test("worker authority is rechecked after setup without repeating reserving beforeTurn", async () => {
  const runtime = new FakeRuntime();
  let authorized = true; let reservations = 0; let checks = 0;
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue",
    beforeTurn: async () => { reservations++; authorized = false; },
    beforeExecution: () => { checks++; if (!authorized) throw Error("worker revoked"); },
  });
  harness.onStateChange = async () => {};
  await harness.accept({ id: "worker", sessionKey: "dispatch:task:token", text: "work", source: "api" });
  await harness.waitForSessionIdle("dispatch:task:token");
  assert.equal(reservations, 1); assert.equal(checks, 2);
  assert.equal(runtime.sessions.get("dispatch:task:token")?.prompts.length ?? 0, 0);
});

test("runtime beforeExecution callback rechecks authority after runtime-local setup", async () => {
  const runtime = new FakeRuntime();
  let authorized = true; let calledModel = false;
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue",
    beforeExecution: () => { if (!authorized) throw Error("revoked during runtime setup"); },
  });
  await harness.sessionFor("worker");
  const session = runtime.sessions.get("worker")!;
  session.prompt = async (_text, options) => {
    authorized = false; // e.g. stop while awaiting a runtime model override
    options?.beforeExecution?.();
    calledModel = true;
    return "must not execute";
  };
  harness.onStateChange = async () => {};
  await harness.accept({ id: "worker", sessionKey: "worker", text: "work", source: "api" });
  await harness.waitForSessionIdle("worker");
  assert.equal(calledModel, false);
});

test("parent stop durably revokes completed results and live worker authority", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-parent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.json");
  const store = new ExecutionStore(file); await store.load();
  const complete = await store.submit("parent", "r1", "work", "direct");
  const first = await store.claim(complete.id); await store.complete(first.id, first.token!, "done");
  const live = await store.submit("parent", "r2", "work", "direct");
  const worker = await store.claim(live.id);
  const bridge = new DispatcherRuntime(new Harness({ runtime: new FakeRuntime(), tickMs: 60000, busyMode: "queue" }), store);
  const key = `dispatch:${live.id}:${worker.token}`;
  assert.equal(bridge.resultAllowed("parent", complete.id), true);
  bridge.guardTool(key, "read");
  assert.throws(() => bridge.guardTool(key, "plugin_loop"), /orchestration/);
  await store.cancelParent("parent");
  assert.equal(bridge.resultAllowed("parent", complete.id), false);
  assert.throws(() => bridge.guardTool(key, "read"), /no longer authorized/);
  await assert.rejects(store.complete(live.id, worker.token!, "late"));
  const reopened = new ExecutionStore(file); await reopened.load();
  assert.ok(reopened.list("parent").every(task => task.parentStopped));
  assert.equal(reopened.events().length, 0);
});

test("parent cancellation signals active workers after durable revocation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-cancel-"));
  const store = new ExecutionStore(path.join(home, "ledger.json")); await store.load();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let revokedOnAbort = false;
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false,
    execute: async (task, context) => {
      started();
      await new Promise<void>(resolve => context.signal.addEventListener("abort", () => {
        revokedOnAbort = store.list().find(item => item.id === task.id)!.parentStopped === true;
        resolve();
      }, { once: true }));
      return "obsolete";
    },
  }, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start();
  const task = await dispatcher.submit("parent", "r", "work"); await entered;
  await dispatcher.cancelParent("parent");
  assert.equal(revokedOnAbort, true);
  assert.equal(store.list()[0]!.status, "cancelled");
  assert.equal(store.events().some(event => event.executionId === task.id && event.type === "result"), false);
});

test("direct dispatcher executes through Harness and durably returns one host result", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-e2e-"));
  const file = path.join(home, "ledger.json");
  const store = new ExecutionStore(file); await store.load();
  const runtime = new FakeRuntime((text, key) => key.startsWith("dispatch:") ? "worker evidence" : `received: ${text}`);
  let bridge!: DispatcherRuntime;
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue",
    beforeExecution: input => bridge.beforeTurn(input.sessionKey),
    hostEventAllowed: input => !!input.hostEvent && bridge.resultAllowed(input.sessionKey, input.hostEvent.executionId),
  });
  harness.onStateChange = async () => {};
  const replies = new MemoryChannel(); harness.addChannel(replies);
  bridge = new DispatcherRuntime(harness, store); harness.addChannel(bridge.channel);
  let delivered!: () => void;
  const received = new Promise<void>(resolve => { delivered = resolve; });
  const errors: unknown[] = [];
  const dispatcher = new Dispatcher(store, bridge.strategy, 1, async event => {
    if (event.type !== "result") return;
    await harness.accept({ id: `dispatch-event:${event.id}`, sessionKey: event.parent, source: "host",
      hostEvent: { executionId: event.executionId }, text: event.text, replyTo: { channel: replies.name, target: "operator" } });
    delivered();
  }, error => errors.push(error));
  t.after(async () => { await dispatcher.stop(); await harness.waitForSessionIdle("parent"); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start();
  const task = await dispatcher.submit("parent", "request", "do authorized work");
  await received; await harness.waitForSessionIdle("parent");
  assert.equal(store.list()[0]!.status, "completed");
  assert.equal(replies.sent.length, 1);
  assert.match(replies.sent[0]!.text, /worker evidence/);
  assert.equal(runtime.opened.filter(item => item.key.startsWith("dispatch:")).length, 1);
  const restored = new ExecutionStore(file); await restored.load();
  assert.equal(restored.list()[0]!.result, "worker evidence");
  assert.equal((await dispatcher.submit("parent", "request", "do authorized work")).id, task.id);
  assert.deepEqual(errors, []);
});

test("operator steering yields a host turn without promoting result data to a mandate", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "steer", hostEventAllowed: () => true });
  harness.onStateChange = async () => {};
  await harness.sessionFor("parent");
  const session = runtime.sessions.get("parent")!;
  const release = session.hold();
  try {
    await harness.accept(host());
    await new Promise(resolve => setImmediate(resolve));
    await harness.accept({ id: "operator-new", source: "channel", sessionKey: "parent", text: "direct question" });
    assert.equal(harness.sessions.get("parent")!.queue.length, 0);
    assert.deepEqual(session.steered, ["direct question"]);
    assert.equal(harness.sessions.get("parent")!.current!.source, "host");
    assert.equal(harness.sessions.get("parent")!.task, undefined);
  } finally { release(); }
  await harness.waitForSessionIdle("parent");
  assert.deepEqual(session.prompts, ["/not-a-command"]);
  assert.equal(harness.sessions.get("parent")!.task, undefined);
});

test("host result never steers a busy operator turn", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "steer", hostEventAllowed: () => true });
  harness.onStateChange = async () => {};
  await harness.sessionFor("parent");
  const release = runtime.sessions.get("parent")!.hold();
  try {
    await harness.accept({ id: "operator", sessionKey: "parent", source: "api", text: "work" });
    await harness.accept(host());
    assert.equal(harness.sessions.get("parent")!.queue.length, 1);
    assert.equal(runtime.sessions.get("parent")!.steered.length, 0);
  } finally { release(); }
  await harness.waitForSessionIdle("parent");
  assert.equal(runtime.sessions.get("parent")!.prompts.length, 2);
});
