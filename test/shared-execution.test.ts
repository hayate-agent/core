import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Dispatcher } from "../src/dispatcher.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Subagents } from "../src/subagents.js";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import type { Inbound } from "../src/types.js";

for (const key of ["main", "subagent:child"]) test(`shared ledger restores settled ${key} turn without runtime replay`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-turn-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const ledger = new ExecutionStore(file); await ledger.load();
  const runtime = new FakeRuntime(() => "external resource created");
  const harness = new Harness({ runtime, executionStore: ledger, tickMs: 60000, busyMode: "queue" });
  const channel = new MemoryChannel(); harness.addChannel(channel);
  let interrupted!: Inbound[];
  harness.onStateChange = async () => {
    if (harness.pendingInputs().some(input => input.started)) interrupted = structuredClone(harness.pendingInputs());
    // Simulate a crash gap: completion cannot reach durable inbox/outbox state.
    if (ledger.turn(interrupted?.[0]?.executionTurnId ?? "", key)?.state === "settled") throw Error("completion save unavailable");
  };
  await harness.accept({ id: "request", source: "api", sessionKey: key, text: "create resource", replyTo: { channel: channel.name, target: "operator" } });
  await harness.waitForSessionIdle(key);
  assert.equal(runtime.sessions.get(key)!.prompts.length, 1);
  assert.equal(channel.sent.length, 0);
  assert.ok(interrupted[0]!.executionTurnId);
  const reopened = new ExecutionStore(file); await reopened.load();
  const replacement = new FakeRuntime();
  const restored = new Harness({ runtime: replacement, executionStore: reopened, tickMs: 60000, busyMode: "queue" });
  restored.addChannel(channel); restored.onStateChange = async () => {};
  restored.restorePending(interrupted); restored.releaseRestored();
  await restored.waitForSessionIdle(key);
  assert.equal(replacement.opened.length, 0);
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0]!.text, "external resource created");
});

test("settled steering inputs are consumed on restart rather than executed again", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-steer-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = new ExecutionStore(path.join(home, "executions.json")); await ledger.load();
  await ledger.beginTurn("primary", "main");
  await ledger.settleTurn("primary", "main", { outbox: [], consumed: ["steered"] });
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, executionStore: ledger, tickMs: 60000, busyMode: "steer" });
  harness.onStateChange = async () => {};
  harness.restorePending([
    { source: "api", sessionKey: "main", text: "original", executionTurnId: "primary", started: true },
    { source: "api", sessionKey: "main", text: "already steered", executionTurnId: "steered" },
    { source: "api", sessionKey: "main", text: "new work", executionTurnId: "next" },
  ]);
  harness.releaseRestored(); await harness.waitForSessionIdle("main");
  assert.deepEqual(runtime.sessions.get("main")!.prompts, ["new work"]);
});

test("dispatcher adopts settled worker outbox before unsafe recovery without another runtime call", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-dispatch-gap-"));
  const file = path.join(home, "ledger.json");
  const store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "r", "work", "direct");
  const claimed = await store.claim(task.id);
  const key = `${task.id}:${claimed.token}`;
  await store.intent(task.id, claimed.token!, `turn:${key}`, "unsafe");
  await store.beginTurn("worker-turn", `dispatch:${key}`);
  await store.settleTurn("worker-turn", `dispatch:${key}`, { consumed: [], outbox: [{
    id: "reply", sessionKey: `dispatch:${key}`, to: { channel: "dispatch", target: key }, text: "x".repeat(64001),
  }] });
  const reopened = new ExecutionStore(file); await reopened.load();
  const runtime = new FakeRuntime();
  const bridge = new DispatcherRuntime(new Harness({ runtime, executionStore: reopened, tickMs: 60000, busyMode: "queue" }), reopened);
  let delivered!: () => void;
  const result = new Promise<void>(resolve => { delivered = resolve; });
  const dispatcher = new Dispatcher(reopened, bridge.strategy, 1, async event => {
    if (event.type === "result") { assert.equal(event.text, "x".repeat(64000)); delivered(); }
  }, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start(); await result;
  assert.equal(reopened.list()[0]!.status, "completed");
  assert.equal(runtime.opened.length, 0);
});

test("failed or mismatched worker settlements cannot clear unsafe intents", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-unsafe-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "ledger.json")); await store.load();
  for (const failure of [true, false]) {
    const task = await store.submit("parent", `r-${failure}`, "work", "direct");
    const claimed = await store.claim(task.id); const key = `${task.id}:${claimed.token}`;
    await store.intent(task.id, claimed.token!, `turn:${key}`, "unsafe");
    await store.beginTurn(`turn-${failure}`, `dispatch:${key}`);
    await store.settleTurn(`turn-${failure}`, `dispatch:${key}`, { consumed: [], outbox: [{
      id: "reply", sessionKey: `dispatch:${key}`, to: { channel: "dispatch", target: failure ? key : "other-token" },
      text: "not successful", ...(failure ? { outcome: "failed" as const } : {}),
    }] });
  }
  await store.recover(new Map([["direct", { version: 1, replaySafe: false }]]));
  assert.ok(store.list().every(task => task.status === "blocked" && task.intent && !task.settledEffect));
});

test("acknowledgement prunes only settled turns and preserves unsafe dispatcher recovery", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-retention-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.json");
  const store = new ExecutionStore(file); await store.load();
  await store.beginTurn("running", "main");
  await store.acknowledgeTurn("running", "main");
  assert.equal(store.turn("running", "main")!.state, "running");
  await store.beginTurn("settled", "main");
  await store.settleTurn("settled", "main", { outbox: [], consumed: [] });
  await store.acknowledgeTurn("settled", "main");
  assert.equal(store.turn("settled", "main"), undefined);
  for (const id of ["crash-after-save", "pending"]) {
    await store.beginTurn(id, "main");
    await store.settleTurn(id, "main", { outbox: [], consumed: [] });
  }
  const task = await store.submit("parent", "r", "work", "direct");
  const claimed = await store.claim(task.id); const key = `${task.id}:${claimed.token}`;
  await store.intent(task.id, claimed.token!, `turn:${key}`, "unsafe");
  await store.beginTurn("worker", `dispatch:${key}`);
  await store.settleTurn("worker", `dispatch:${key}`, { outbox: [], consumed: [] });
  await store.acknowledgeTurn("worker", `dispatch:${key}`);
  assert.equal(store.turn("worker", `dispatch:${key}`)!.state, "settled");
  await store.beginTurn("orphan-heartbeat", "heartbeat");
  await store.reconcileSettledTurns(new Set(["pending", "running"]));
  assert.equal(store.turn("orphan-heartbeat", "heartbeat"), undefined);
  assert.equal(store.turn("crash-after-save", "main"), undefined);
  assert.equal(store.turn("pending", "main")!.state, "settled");
  assert.equal(store.turn("worker", `dispatch:${key}`)!.state, "settled");
  await store.settleIntent(task.id, claimed.token!, `turn:${key}`, "done", "done");
  assert.equal(store.turn("worker", `dispatch:${key}`), undefined);
  const reopened = new ExecutionStore(file); await reopened.load();
  assert.equal(reopened.turn("settled", "main"), undefined);
  assert.equal(reopened.turn("running", "main")!.state, "running");
});

test("managed Subagents use and acknowledge the common ledger through their real result channel", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-managed-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = new ExecutionStore(path.join(home, "ledger.json")); await ledger.load();
  const runtime = new FakeRuntime(() => "verified child evidence");
  let manager!: Subagents; let turnId: string | undefined;
  const harness = new Harness({ runtime, executionStore: ledger, tickMs: 60000, busyMode: "queue",
    beforeExecution: input => manager.beforeTurn(input.sessionKey),
    turnCommitted: async input => { turnId = input.executionTurnId; assert.equal(ledger.turn(turnId!, input.sessionKey)!.state, "settled"); },
  });
  harness.onStateChange = async () => {};
  manager = new Subagents(harness, async () => {}); harness.addChannel(manager.channel);
  const child = await manager.start("parent", { task: "test", context: "authorized", constraints: "no deployment",
    expectedResult: "evidence", acceptance: "passes", model: "provider/small", thinking: "low" });
  await harness.waitForSessionIdle(child.sessionKey);
  assert.equal(manager.get("parent", child.id).state, "completed");
  assert.equal(manager.get("parent", child.id).result, "verified child evidence");
  assert.ok(turnId); assert.equal(ledger.turn(turnId, child.sessionKey), undefined);
  assert.equal(runtime.sessions.get(child.sessionKey)!.prompts.length, 1);
});

test("retention limits reject new identities but allow existing work to finish", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-limits-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.json");
  await writeFile(file, JSON.stringify({ version: 1, events: [],
    turns: Array.from({ length: 10000 }, (_, index) => ({ id: `turn-${index}`, sessionKey: "main", state: "running" })),
    executions: Array.from({ length: 2000 }, (_, index) => ({ id: `task-${index}`, parent: "p", requestId: `r-${index}`,
      input: "work", strategy: "direct", strategyVersion: 1, status: "completed", result: "done", restarts: 0 })),
  }));
  const store = new ExecutionStore(file); await store.load();
  await assert.rejects(store.beginTurn("extra", "main"), /turn limit/);
  await assert.rejects(store.submit("p", "extra", "work", "direct"), /execution limit/);
  assert.equal((await store.submit("p", "r-0", "work", "direct")).id, "task-0");
  await store.beginTurn("turn-0", "main");
  await store.settleTurn("turn-0", "main", { outbox: [], consumed: [] });
  await store.acknowledgeTurn("turn-0", "main");
  await store.beginTurn("extra", "main");
  assert.equal(store.turn("extra", "main")!.state, "running");
});

test("stop racing a delayed settlement prevents successful delivery and continuation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-stop-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let entered!: () => void; let release!: () => void;
  const committing = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  class DelayedStore extends ExecutionStore {
    override async settleTurn(...args: Parameters<ExecutionStore["settleTurn"]>) {
      entered(); await gate; return super.settleTurn(...args);
    }
  }
  const ledger = new DelayedStore(path.join(home, "ledger.json")); await ledger.load();
  const harness = new Harness({ runtime: new FakeRuntime(() => "successful result"), executionStore: ledger, tickMs: 60000, busyMode: "queue",
    completionCheck: async () => ({ state: "continue", next: "must not run" }),
  });
  const channel = new MemoryChannel(); harness.addChannel(channel); harness.onStateChange = async () => {};
  await harness.accept({ id: "operator", source: "channel", sessionKey: "main", text: "work", replyTo: { channel: channel.name, target: "operator" } });
  await committing;
  await harness.stopConversation("main");
  release(); await harness.waitForSessionIdle("main");
  assert.equal(channel.sent.length, 1);
  assert.equal(channel.sent[0]!.meta?.outcome, "cancelled");
  assert.doesNotMatch(channel.sent[0]!.text, /successful result/);
  assert.equal(harness.sessions.get("main")!.task!.state, "stopped");
  assert.equal(harness.pendingInputs().length, 0);
});

test("durable stop sanitizes settlements regardless of commit ordering", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-stop-order-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.json");
  const store = new ExecutionStore(file); await store.load();
  for (const stopFirst of [true, false]) {
    const id = `turn-${stopFirst}`;
    await store.beginTurn(id, "main");
    if (stopFirst) await store.stopTurn(id, "main");
    await store.settleTurn(id, "main", { consumed: [], continuation: { state: "continue", next: "unsafe follow-up" },
      outbox: [{ id: "reply", sessionKey: "main", to: { channel: "test", target: "p" }, text: "success" }] });
    if (!stopFirst) await store.stopTurn(id, "main");
  }
  const reopened = new ExecutionStore(file); await reopened.load();
  for (const id of ["turn-true", "turn-false"]) {
    assert.equal(reopened.turn(id, "main")!.stopped, true);
    assert.equal(reopened.turn(id, "main")!.settlement!.continuation, undefined);
    assert.equal(reopened.turn(id, "main")!.settlement!.outbox[0]!.outcome, "cancelled");
  }
});

test("restored stopped running turn never invokes the model", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-stopped-running-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = new ExecutionStore(path.join(home, "ledger.json")); await ledger.load();
  // Stop arrives while the initial inbox save is awaiting, before beginTurn.
  await ledger.stopTurn("stopped", "main");
  await ledger.beginTurn("stopped", "main");
  const reopened = new ExecutionStore(path.join(home, "ledger.json")); await reopened.load();
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, executionStore: reopened, tickMs: 60000, busyMode: "queue" });
  harness.onStateChange = async () => {};
  harness.restorePending([{ source: "api", sessionKey: "main", text: "must not execute", executionTurnId: "stopped" }]);
  harness.releaseRestored(); await harness.waitForSessionIdle("main");
  assert.equal(runtime.sessions.get("main")?.prompts.length ?? 0, 0);
});

test("settled continuation restores once and honors inherited deadline", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-continuation-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  for (const expired of [false, true]) {
    const ledger = new ExecutionStore(path.join(home, `${expired}.json`)); await ledger.load();
    await ledger.beginTurn("original", "main");
    await ledger.settleTurn("original", "main", { outbox: [], consumed: [], continuation: { state: "continue", next: "verify saved next step" } });
    const runtime = new FakeRuntime();
    const harness = new Harness({ runtime, executionStore: ledger, tickMs: 60000, busyMode: "queue", now: () => 1000 });
    harness.onStateChange = async () => {};
    harness.restorePending([{ id: "original", source: "channel", sessionKey: "main", text: "authorized original", taskId: "task",
      executionTurnId: "original", continuationExpiresAt: expired ? 999 : 2000 }]);
    harness.releaseRestored(); await harness.waitForSessionIdle("main");
    const prompts = runtime.sessions.get("main")?.prompts ?? [];
    assert.equal(prompts.length, expired ? 0 : 1);
    if (!expired) assert.match(prompts[0]!, /verify saved next step/);
    assert.equal(harness.pendingInputs().length, 0);
  }
});

test("persisted settlement schema rejects corrupt identities, routing and continuation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-schema-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.json");
  const base = { id: "turn", sessionKey: "main", state: "settled", settlement: { outbox: [], consumed: [] } };
  for (const turn of [
    { ...base, stopped: "yes" }, { ...base, settlement: null },
    { ...base, settlement: { outbox: [], consumed: [42] } },
    { ...base, settlement: { outbox: [], consumed: [], continuation: { state: "continue", next: "" } } },
    { ...base, settlement: { outbox: [], consumed: [], goal: { text: "x", criteria: [], paused: false, turns: -1 } } },
    { ...base, settlement: { consumed: [], outbox: [{ id: "reply", sessionKey: "other", text: "x", to: { channel: "test", target: "p" } }] } },
    { ...base, state: "running" },
  ]) {
    await writeFile(file, JSON.stringify({ version: 1, executions: [], events: [], turns: [turn] }));
    await assert.rejects(new ExecutionStore(file).load(), /Invalid|Unexpected/);
  }
  await writeFile(file, JSON.stringify({ version: 1, executions: [], events: [], turns: [base, base] }));
  await assert.rejects(new ExecutionStore(file).load(), /Invalid durable turn/);
});

test("unsettled ordinary turns preserve at-least-once recovery", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "shared-running-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = new ExecutionStore(path.join(home, "executions.json")); await ledger.load();
  await ledger.beginTurn("turn", "main");
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, executionStore: ledger, tickMs: 60000, busyMode: "queue" });
  harness.onStateChange = async () => {};
  harness.restorePending([{ id: "request", source: "api", sessionKey: "main", text: "reconcile before retry", executionTurnId: "turn", started: true }]);
  harness.releaseRestored(); await harness.waitForSessionIdle("main");
  assert.equal(runtime.sessions.get("main")!.prompts.length, 1);
  assert.equal(ledger.turn("turn", "main"), undefined); // completion checkpoint acknowledged
});
