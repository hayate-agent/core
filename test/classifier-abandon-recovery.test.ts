import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExecutionStore } from "../src/execution.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

const route = { model: "p/classifier", thinking: "off" };
const defaults = { model: "p/default", thinking: "off" };
const strategy = { name: "direct", version: 1, replaySafe: false, reconcile: true, execute: async () => "done" };
async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "classifier-abandon-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = Date.now(); const file = path.join(dir, "executions.json");
  const store = new ExecutionStore(file, { now: () => now }); await store.load();
  return { store, file, advance: (ms: number) => { now += ms; } };
}
for (const phase of ["initial", "fallback"] as const) for (const interrupted of [true, false])
test(`interrupted classifier ${phase} recovers same execution without HTTP replay (running=${interrupted})`, async t => {
  const { store, file } = await fixture(t);
  const submitted = await store.submit("parent", "stable", "work", "direct");
  const task = await store.claim(submitted.id);
  await store.classifierAssessment(task.id, task.token!, { phase: "initial", actual: route });
  if (phase === "fallback") await store.classifierAssessment(task.id, task.token!, { phase, actual: route });
  if (!interrupted) await store.fail(task.id, task.token!, "runtime-failure"); // pre-fix paused record
  const reload = new ExecutionStore(file); await reload.load();
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  let sends = 0, workers = 0;
  Object.assign(harness.runtime, { classifyComplexityHttp: async () => { sends++; throw Error("must not repeat HTTP"); } });
  const bridge = new DispatcherRuntime(harness, reload, undefined, () => ({ config: { enabled: true }, defaults }));
  Object.assign(bridge, { runTurn: async (_c: unknown, _k: string, _s: string, _p: string, selected: unknown) => {
    workers++; assert.deepEqual(selected, defaults); return "done";
  } });
  await reload.recover(new Map([["direct", bridge.strategy]]));
  if (!interrupted) {
    await reload.retryWorker(task.id, bridge.strategy);
    assert.equal(reload.list()[0].classifierReceipt?.phase, "abandoned");
    const due = reload.list()[0].workerRetry!.nextAt;
    // Use a store clock after the retained backoff for deterministic claim.
    const dueStore = new ExecutionStore(file, { now: () => due }); await dueStore.load();
    await dueStore.retryWorker(task.id, bridge.strategy);
    const dueBridge = new DispatcherRuntime(harness, dueStore, undefined, () => ({ config: { enabled: true }, defaults }));
    Object.assign(dueBridge, { runTurn: async () => { workers++; return "done"; } });
    const next = await dueStore.claim(task.id);
    assert.equal(await dueBridge.strategy.execute(next, { signal: new AbortController().signal,
      intent: (key, replay, selected) => dueStore.intent(task.id, next.token!, key, replay, selected),
      checkpoint: async () => {}, settleIntent: (key, result, checkpoint) => dueStore.settleIntent(task.id, next.token!, key, result, checkpoint),
    }), "done");
  } else {
    assert.equal(reload.list()[0].status, "ready");
    const next = await reload.claim(task.id);
    assert.equal(await bridge.strategy.execute(next, { signal: new AbortController().signal,
      intent: (key, replay, selected) => reload.intent(task.id, next.token!, key, replay, selected),
      checkpoint: async () => {}, settleIntent: (key, result, checkpoint) => reload.settleIntent(task.id, next.token!, key, result, checkpoint),
    }), "done");
  }
  assert.equal(sends, 0); assert.equal(workers, 1);
});
for (const hold of ["manual", "cancel", "expired", "policy", "intent", "strategy"] as const)
test(`abandonment does not bypass ${hold}`, async t => {
  const { store, advance } = await fixture(t);
  const submitted = await store.submit("parent", "r", "work", "direct", 1, { taskId: "m", original: "work", depth: 0, expiresAt: Date.now() + 1000 });
  const task = await store.claim(submitted.id);
  await store.classifierAssessment(task.id, task.token!, { phase: "initial", actual: route });
  if (hold === "intent") await store.intent(task.id, task.token!, "effect", "unsafe");
  if (hold === "manual") await store.control(task.id, "pause");
  else if (hold === "cancel") await store.control(task.id, "cancel");
  else {
    if (hold === "expired") advance(2000);
    await store.fail(task.id, task.token!, "runtime-failure");
  }
  await store.retryWorker(task.id, hold === "strategy" ? { ...strategy, version: 2 } : strategy,
    hold === "policy" ? { name: "required", evaluate: () => "real gate" } : undefined);
  const row = store.list()[0];
  assert.notEqual(row.status, "ready"); assert.equal(row.workerRetry, undefined);
  assert.equal(row.classifierReceipt?.phase, "initial");
});
test("abandonment mutation fences stale claims and expired mandates", async t => {
  const { store, advance } = await fixture(t);
  const task = await store.claim((await store.submit("p", "r", "work", "direct", 1, { taskId: "m", original: "work", depth: 0, expiresAt: Date.now() + 1000 })).id);
  await store.classifierAssessment(task.id, task.token!, { phase: "initial", actual: route });
  await assert.rejects(store.abandonClassifier(task.id, "stale"), /Stale/);
  advance(2000); await assert.rejects(store.abandonClassifier(task.id, task.token!), /deadline/i);
  assert.equal(store.list()[0].classifierReceipt?.phase, "initial");
});
