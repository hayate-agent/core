import test from "node:test";
import assert from "node:assert/strict";
import { assessCompletion } from "../src/completion-check.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { legacyLLMProvider } from "../src/builtin-plugins/completion-validator-plugin.js";
import { ValidatorRegistry, completionFailureDetail } from "../src/validator.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

test("absent registry, absent selection and unknown provider are explicit errors, never cloud fallback", async () => {
  let cloudCalls = 0;
  const backend = { async review() { cloudCalls++; return '{"state":"completed"}'; } };
  const run = (registry?: ValidatorRegistry) => assessCompletion(backend, { sessionKey: "chat", source: "channel", text: "task" }, "report", { task: "task" }, new AbortController().signal, undefined, Date.now, completionPrompt, undefined, 100, registry);
  await assert.rejects(run(), /registry is required/);
  const registry = new ValidatorRegistry(); registry.register(legacyLLMProvider);
  await assert.rejects(run(registry), /provider is required/);
  assert.throws(() => registry.select(undefined), /provider is required/);
  registry.select("missing"); await assert.rejects(run(registry), /not registered/);
  assert.equal(cloudCalls, 0);
  registry.select(false); assert.equal(await run(registry), undefined);
  registry.select("legacy-llm"); assert.deepEqual(await run(registry), { state: "completed" });
  assert.equal(cloudCalls, 1, "only explicit legacy selection may call its backend");
});

test("provider cause survives public Harness snapshot without exception secrets", async () => {
  const registry = new ValidatorRegistry();
  registry.register({ apiVersion: 1, name: "broken", version: 1, async assess() {
    throw Object.assign(Error("secret endpoint token"), { code: "ECONNREFUSED", status: 503 });
  } });
  registry.select("broken");
  const runtime = new FakeRuntime((_text, key) => { h.planContinuation(key, { state: "completed" }); return "Done"; });
  const h: Harness = new Harness({ runtime, tickMs: 60000, completionCheck: (input, reply, signal, diagnostic) =>
    assessCompletion({ review: async () => { throw Error("cloud must not run"); } }, input, reply,
      input.completionAnchor ? { task: input.completionAnchor.task } : undefined, signal, undefined, Date.now, completionPrompt, diagnostic, 1000, registry) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Verify the implementation")); await h.drained();
    const snapshot = h.snapshotSessions();
    const task = snapshot[0]!.tasks![0]!;
    assert.equal(task.supervisorDecision?.diagnostic, "technical");
    assert.deepEqual(task.supervisorDecision?.detail, { cause: "provider_error", code: "ECONNREFUSED", status: 503 });
    assert.equal(JSON.stringify(snapshot).includes("secret endpoint token"), false);
    assert.notEqual(task.state, "completed");
  } finally { await h.stop(0); }
});

test("public failure projection rejects untrusted fields and hostile getters", () => {
  assert.deepEqual(completionFailureDetail({ cause: "provider_error", code: "secret", status: 200, message: "secret" }), { cause: "provider_error" });
  assert.equal(completionFailureDetail({ get cause() { throw Error("secret"); } }), undefined);
});
