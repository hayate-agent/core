import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { ExecutionStore } from "../src/execution.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";

// The unknown classifier HTTP call is never repeated; worker execution is
// separately fenced by the ordinary intent and settlement protocol.
test("real Harness bridge abandons interrupted classification and executes once on the configured default", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "classifier-harness-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const runtime = new FakeRuntime();
  let assessments = 0;
  Object.assign(runtime, {
    modelPreflight: async () => ({ available: true, thinkingSupported: true }),
    classifyComplexityHttp: async (assessment: import("../src/classifier-http.js").ClassifierAssessment) => {
      assessments++;
      await assessment.persist({ phase: "initial", actual: assessment.requested });
      assessment.authorize();
      throw Error("crash after marker before outcome");
    },
  });
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue" });
  const bridge = new DispatcherRuntime(harness, store, undefined, () => ({
    config: { enabled: true, roles: { dispatcher: { model: "p/classifier", thinking: "off" } } },
    defaults: { model: "p/default", thinking: "off" },
  }));
  let workers = 0;
  Object.assign(bridge, { runTurn: async (_context: unknown, _key: string, _session: string, _prompt: string, selected: unknown) => {
    workers++; assert.deepEqual(selected, { model: "p/default", thinking: "off" }); return "done";
  } });
  const submitted = await store.submit("parent", "request", "work", "direct");
  const task = await store.claim(submitted.id);
  assert.equal(await bridge.strategy.execute(task, { signal: new AbortController().signal,
    intent: (key, replay, route) => store.intent(task.id, task.token!, key, replay, route),
    checkpoint: async () => {}, settleIntent: (key, result, checkpoint) => store.settleIntent(task.id, task.token!, key, result, checkpoint),
  }), "done");
  const reload = new ExecutionStore(path.join(home, "executions.json")); await reload.load();
  await reload.recover(new Map([["direct", bridge.strategy]]));
  const retained = reload.list()[0]!;
  assert.equal(retained.status, "ready");
  assert.equal(retained.parent, "parent");
  assert.equal(retained.classifierReceipt?.phase, "abandoned");
  assert.equal(retained.intent, undefined);
  assert.equal(assessments, 1);
  assert.equal(workers, 1);
  assert.equal(harness.sessions.size, 0);
});
