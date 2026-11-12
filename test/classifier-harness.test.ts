import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { ExecutionStore } from "../src/execution.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";

// Real Harness/bridge/store boundary: persistence must settle before the runtime
// can send, and an unknown marker must not turn into a worker/default loop.
test("real Harness bridge retains unknown classifier receipt and recovery route", async t => {
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
  const submitted = await store.submit("parent", "request", "work", "direct");
  const task = await store.claim(submitted.id);
  await assert.rejects(bridge.strategy.execute(task, { signal: new AbortController().signal,
    intent: (key, replay, route) => store.intent(task.id, task.token!, key, replay, route),
    checkpoint: async () => {}, settleIntent: async () => {},
  }), /crash after marker/);
  const reload = new ExecutionStore(path.join(home, "executions.json")); await reload.load();
  await reload.recover(new Map([["direct", bridge.strategy]]));
  const retained = reload.list()[0]!;
  assert.equal(retained.status, "blocked");
  assert.equal(retained.parent, "parent");
  assert.equal(retained.classifierReceipt?.phase, "initial");
  assert.equal(retained.intent, undefined);
  assert.equal(assessments, 1);
  assert.equal(harness.sessions.size, 0);
});
