import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import type { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { validateWorkerPin } from "../src/model-roles.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PIN = { model: "homelab/qwen3.8-27b-coder", thinking: "xhigh" } as const;
const RULE = { match: {}, model: "homelab/other", thinking: "medium" };

interface Accepted { replyTo: { target: string }; turn?: { model?: string; thinking?: string } }

async function fixture(preflight: (ref: string, thinking?: string) => Promise<{ available: boolean; thinkingSupported: boolean }>, rules?: unknown[]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dispatch-pin-"));
  const store = new ExecutionStore(path.join(dir, "executions.json"), 7);
  await store.load();
  const accepted: Accepted[] = [];
  const preflightCalls: Array<[string, string | undefined]> = [];
  let bridge: DispatcherRuntime;
  const harness = {
    runtime: {
      modelPreflight: async (ref: string, thinking?: string) => {
        preflightCalls.push([ref, thinking]);
        return preflight(ref, thinking);
      },
    },
    reconcileSession: async () => {},
    accept: async (input: Accepted) => {
      accepted.push(input);
      // Reply through the real dispatch channel so the worker turn completes.
      void bridge.channel.send({ channel: "dispatch", target: input.replyTo.target }, "worker answer");
    },
  } as unknown as Harness;
  bridge = new DispatcherRuntime(harness, store, rules as never);
  const task = await store.submit("p/big", "r-1", "bounded task", "direct", 1, undefined, undefined);
  const claimed = await store.claim(task.id);
  return { dir, store, accepted, preflightCalls, bridge, task: claimed ?? task, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const contextFor = (task: { id: string; token?: string }, signal: AbortSignal) => ({
  signal,
  checkpoint: async () => {},
  reply: async () => {},
  question: async () => "",
  ask: async () => ({ answer: "", cancelled: false }),
  intent: async (_key: string, _replay: string, route: unknown) => {
    const intent = (task.intent ??= { key: _key, replay: _replay as "safe" | "unsafe" });
    intent.route = route as never;
  },
  settleIntent: async () => {},
});

test("pinned task uses the pinned pair and ignores routing rules", async () => {
  const f = await fixture(async () => ({ available: true, thinkingSupported: true }), [RULE]);
  try {
    f.task.pinned = { ...PIN };
    const answer = await f.bridge.strategy.execute(f.task, contextFor(f.task, new AbortController().signal) as never);
    assert.equal(answer, "worker answer");
    assert.equal(f.accepted.length, 1);
    assert.deepEqual(f.accepted[0].turn, { model: PIN.model, thinking: PIN.thinking });
    // The pin must be validated against the runtime, never silently swapped.
    assert.deepEqual(f.preflightCalls, [[PIN.model, PIN.thinking]]);
    assert.deepEqual(f.task.intent?.route, { model: PIN.model, thinking: PIN.thinking });
  } finally { await f.cleanup(); }
});

test("pinned task with an unsupported thinking level fails without a worker turn", async () => {
  const f = await fixture(async () => ({ available: true, thinkingSupported: false }));
  try {
    f.task.pinned = { model: PIN.model, thinking: "low" };
    await assert.rejects(
      () => f.bridge.strategy.execute(f.task, contextFor(f.task, new AbortController().signal) as never),
      /Pinned worker thinking level unsupported/,
    );
    assert.deepEqual(f.accepted, []);
  } finally { await f.cleanup(); }
});

test("pinned task with an unavailable model fails without a worker turn", async () => {
  const f = await fixture(async () => ({ available: false, thinkingSupported: true }));
  try {
    f.task.pinned = { ...PIN };
    await assert.rejects(
      () => f.bridge.strategy.execute(f.task, contextFor(f.task, new AbortController().signal) as never),
      /Pinned worker model unavailable/,
    );
    assert.deepEqual(f.accepted, []);
  } finally { await f.cleanup(); }
});

test("a retained intent route survives recovery and is not re-preflighted", async () => {
  const f = await fixture(async () => ({ available: true, thinkingSupported: true }), [RULE]);
  try {
    f.task.pinned = { ...PIN };
    f.task.recoverySession = "retained-worker-session";
    f.task.intent = { key: `turn:${f.task.id}:${f.task.token}`, replay: "unsafe", route: { model: "homelab/retained", thinking: "minimal" } };
    await f.bridge.strategy.execute(f.task, contextFor(f.task, new AbortController().signal) as never);
    assert.deepEqual(f.accepted[0].turn, { model: "homelab/retained", thinking: "minimal" });
    assert.deepEqual(f.preflightCalls, [], "recovery must keep the recorded pair instead of re-resolving");
  } finally { await f.cleanup(); }
});

test("worker pin validation is strict about both halves", () => {
  assert.doesNotThrow(() => validateWorkerPin({ model: "p/m", thinking: "off" }));
  assert.throws(() => validateWorkerPin({ model: "p/m", thinking: "ultra" }), /Invalid worker pin thinking/);
  assert.throws(() => validateWorkerPin({ model: "bare", thinking: "off" }), /Invalid worker pin model ref/);
  assert.throws(() => validateWorkerPin({ thinking: "off" }), /Invalid worker pin model ref/);
  assert.throws(() => validateWorkerPin({ model: "p/m", thinking: "off", extra: 1 }), /Invalid worker pin/);
  assert.throws(() => validateWorkerPin(undefined), /Invalid worker pin/);
  assert.throws(() => validateWorkerPin(["p/m", "off"]), /Invalid worker pin/);
});
