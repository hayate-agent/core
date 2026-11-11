import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore, ExecutionWorkerFailure } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { ApiChannel } from "../src/api/server.js";
import { Subagents } from "../src/subagents.js";
import { FakeRuntime } from "./fakes.js";
import type { RuntimeSession } from "../src/types.js";

const hold = { state: "blocked" as const, operationId: "operation", failedAttempts: 1, reason: "uncertain" as const };

test("structured maintenance traverses durable outbox: blocked worker is never success or automatic worker retry", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-routing-"));
  const store = new ExecutionStore(path.join(home, "ledger.json")); await store.load();
  const task = await store.submit("parent", "request", "approved work", "direct");
  const running = await store.claim(task.id);
  const key = `dispatch:${task.id}:${running.token}`;
  const target = { channel: "dispatch", target: `${task.id}:${running.token}` };
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  const session = { status: () => ({ sessionId: "old", contextPercent: 20 }), compact: async () => { throw Error("uncertain compact"); } } as unknown as RuntimeSession;
  await maintenance.prepareContinuation(key, session, async () => { throw Error("must not rotate"); }, "compact", "approved work", "verify", target);
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, contextMaintenance: maintenance, tickMs: 60000 });
  h.onStateChange = async () => {};
  const bridge = new DispatcherRuntime(h, store); h.addChannel(bridge.channel);
  t.after(async () => { await h.stop(0); await rm(home, { recursive: true, force: true }); });
  const result = bridge.strategy.execute(running, {
    signal: new AbortController().signal,
    intent: (id, replay) => store.intent(task.id, running.token!, id, replay),
    checkpoint: value => store.checkpoint(task.id, running.token!, value),
    settleIntent: (id, value, checkpoint) => store.settleIntent(task.id, running.token!, id, value, checkpoint),
  });
  let failure: ExecutionWorkerFailure | undefined;
  const checked = assert.rejects(result, error => {
    assert.ok(error instanceof ExecutionWorkerFailure); assert.equal(error.diagnosticCode, "maintenance-blocked"); failure = error; return true;
  });
  for (let i = 0; i < 20 && !failure; i++) { await new Promise(r => setTimeout(r, 5)); await h.tick(); }
  await checked;
  assert.equal(runtime.sessions.get(key)?.prompts.length ?? 0, 0);
  await store.fail(task.id, running.token!, failure!.diagnosticCode, { strategy: bridge.strategy });
  const restored = new ExecutionStore(path.join(home, "ledger.json")); await restored.load();
  const blocked = restored.list().find(item => item.id === task.id)!;
  assert.equal(blocked.status, "blocked"); assert.equal(blocked.diagnosticCode, "maintenance-blocked");
  assert.equal(blocked.workerRetry, undefined, "maintenance exhaustion must not start a fresh worker automatically");
  assert.equal(blocked.recoverySession, key);
});

test("dispatcher waiting/informational maintenance is not a completed working result", async () => {
  let bridge!: DispatcherRuntime;
  const h = { accept: async (input: { replyTo: { target: string } }) => {
    const to = { channel: "dispatch", target: input.replyTo.target };
    await bridge.channel.send(to, "waiting", { maintenance: { ...hold, state: "waiting", notBefore: 5000, reason: "backoff" } });
    await bridge.channel.send(to, "maintenance success notice", { maintenance: { state: "notice" } });
    await bridge.channel.send(to, "actual working result");
  } } as unknown as Harness;
  bridge = new DispatcherRuntime(h, {} as ExecutionStore);
  const result = await bridge.strategy.execute({ id: "task", token: "token", input: "approved work" } as never, {
    signal: new AbortController().signal, intent: async () => {}, checkpoint: async () => {}, settleIntent: async () => {},
  });
  assert.equal(result, "actual working result");
});

test("API maintenance notices do not finish runs successfully; terminal hold is failed, not success", async () => {
  const finished: unknown[][] = [];
  const channel = new ApiChannel({ key: "test-only-key", runs: { finish: async (...args: unknown[]) => { finished.push(args); } } } as never);
  const to = { channel: "api", target: "run" };
  await channel.send(to, "waiting", { maintenance: { ...hold, state: "waiting", reason: "backoff", notBefore: 1000 } });
  await channel.send(to, "notice", { maintenance: { state: "notice" } });
  assert.equal(finished.length, 0);
  await channel.send(to, "blocked", { maintenance: hold });
  assert.deepEqual(finished, [["run", "blocked", "failed"]]);
});

test("subagent maintenance cannot manufacture a completed child result", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); h.paused = true; h.onStateChange = async () => {};
  const manager = new Subagents(h, async () => {}); h.addChannel(manager.channel);
  try {
    const child = await manager.start("parent", { task: "approved work", context: "retained context", constraints: "no deployment", expectedResult: "verified result", acceptance: "tests pass", model: "provider/small", thinking: "low" } as never);
    const to = { channel: "subagents", target: child.id };
    await manager.channel.send(to, "waiting", { maintenance: { state: "notice" } });
    assert.equal(manager.get("parent", child.id).state, "queued");
    await manager.channel.send(to, "blocked", { maintenance: hold });
    assert.equal(manager.get("parent", child.id).state, "failed");
  } finally { await h.stop(0); }
});
