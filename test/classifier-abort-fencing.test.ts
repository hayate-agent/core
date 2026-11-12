import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExecutionStore } from "../src/execution.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

for (const failure of ["timeout", "abort", "pause", "cancel", "persistence"] as const)
test(`classifier ${failure} falls back only at an owned durable boundary`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "classifier-fence-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const runtime = new FakeRuntime(); const controller = new AbortController();
  let sends = 0, workers = 0;
  const task = await store.claim((await store.submit("p", "r", "work", "direct")).id);
  Object.assign(runtime, { classifyComplexityHttp: async (assessment: import("../src/classifier-http.js").ClassifierAssessment) => {
    sends++;
    await assessment.persist({ phase: "initial", actual: assessment.requested });
    if (failure === "abort") controller.abort();
    if (failure === "pause" || failure === "cancel") await store.control(task.id, failure);
    throw Error("Assessment stopped");
  } });
  if (failure === "persistence") t.mock.method(store, "abandonClassifier", async () => { throw Error("disk unavailable"); });
  const harness = new Harness({ runtime, tickMs: 60000 });
  const defaults = { model: "p/default", thinking: "off" };
  const bridge = new DispatcherRuntime(harness, store, undefined, () => ({ config: { enabled: true }, defaults }));
  Object.assign(bridge, { runTurn: async (_c: unknown, _k: string, _s: string, _p: string, selected: unknown) => {
    workers++; assert.deepEqual(selected, defaults); return "done";
  } });
  const run = bridge.strategy.execute(task, { signal: controller.signal,
    intent: (key, replay, route) => store.intent(task.id, task.token!, key, replay, route),
    checkpoint: async () => {}, settleIntent: (key, result, checkpoint) => store.settleIntent(task.id, task.token!, key, result, checkpoint),
  });
  if (failure === "timeout") assert.equal(await run, "done");
  else await assert.rejects(run, /stopped|Stale|disk unavailable/);
  assert.equal(sends, 1); assert.equal(workers, failure === "timeout" ? 1 : 0);
  assert.equal(store.list()[0].classifierReceipt?.phase, failure === "timeout" ? "abandoned" : "initial");
});
