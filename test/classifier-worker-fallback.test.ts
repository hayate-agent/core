import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import type { AgentRuntime, Inbound } from "../src/types.js";
import type { Harness } from "../src/harness.js";

for (const failure of ["unknown", "invalid", "already-abandoned"] as const) test(`unclassified worker uses configured high worker, never Main: ${failure}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "classifier-worker-fallback-")); t.after(() => rm(home, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const task = await store.submit("parent", "request", "Do the already authorized fixture once", "direct"); const claimed = await store.claim(task.id);
  const classifier = { model: "local/fast-dispatcher", thinking: "off" }, worker = { model: "local/coder", thinking: "high" }, main = { model: "local/main", thinking: "medium" };
  if (failure === "already-abandoned") {
    await store.classifierAssessment(task.id, claimed.token!, { phase: "initial", actual: classifier });
    await store.abandonClassifier(task.id, claimed.token!);
  }
  let classifications = 0, effects = 0; let selected: unknown; let bridge!: DispatcherRuntime;
  const runtime = { modelPreflight: async () => ({ available: true, thinkingSupported: true }), classifyComplexityHttp: async (a: any) => {
    classifications++; assert.deepEqual(a.requested, classifier); assert.deepEqual(a.defaults, classifier, "HTTP fallback must not change dispatcher into Main/thinking");
    await a.persist({ phase: "initial", actual: classifier });
    if (failure === "unknown") throw Error("synthetic HTTP outcome unknown");
    await a.persist({ phase: "observed", actual: classifier }); return undefined;
  } } as unknown as AgentRuntime;
  const harness = { runtime, accept: async (input: Inbound) => {
    effects++; selected = input.turn; await bridge.channel.send({ channel: "dispatch", target: input.replyTo!.target }, "fixture completed once");
  } } as unknown as Harness;
  bridge = new DispatcherRuntime(harness, store, undefined, () => ({ config: { enabled: true, roles: { dispatcher: classifier, high: worker } }, defaults: main }));
  const ctx = { signal: new AbortController().signal, checkpoint: async () => {},
    intent: (key: string, replay: "safe" | "unsafe", route: any) => store.intent(task.id, claimed.token!, key, replay, route),
    settleIntent: (key: string, result: string, checkpoint?: string) => store.settleIntent(task.id, claimed.token!, key, result, checkpoint) };
  const result = await bridge.strategy.execute(store.list()[0]!, ctx);
  assert.equal(result, "fixture completed once"); assert.deepEqual(selected, worker); assert.equal(effects, 1);
  assert.equal(classifications, failure === "already-abandoned" ? 0 : 1);
  assert.equal(store.list()[0]!.classifierReceipt?.complexity, undefined, "no invented complexity verdict");
  const restored = new ExecutionStore(path.join(home, "executions.json")); await restored.load();
  assert.equal(await new DispatcherRuntime(harness, restored).strategy.execute(restored.list()[0]!, ctx), result);
  assert.equal(effects, 1, "settled productive effects never replay");
});
