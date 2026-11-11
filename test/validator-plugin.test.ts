import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginHost } from "../src/plugins.js";
import { ValidatorRegistry, type ValidatorProvider } from "../src/validator.js";
import { validatorPlugin, legacyLLMProvider } from "../src/builtin-plugins/completion-validator-plugin.js";
import { assessCompletion } from "../src/completion-check.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { stepCompletionPrompt } from "../src/dispatcher-step-prompt.js";
import type { Inbound } from "../src/types.js";

const input = (): Inbound => ({ sessionKey: "chat", source: "channel", text: "Finish authorized tests" });
const grant = { task: "Finish authorized tests", expiresAt: 2000 };
const signal = () => new AbortController().signal;
const backend = { review: async () => '{"state":"completed"}' };
const provider = (name = "dedicated"): ValidatorProvider => ({ apiVersion: 1, name, version: 1, async assess() { return { state: "completed" }; } });
const assess = (registry: ValidatorRegistry, value = input(), auth: typeof grant | undefined = grant, abort = signal()) =>
  assessCompletion(backend, value, "report", auth, abort, undefined, () => 1000, completionPrompt, undefined, 1000, registry);

test("provider registry validates protocol, identity, version, duplicates and selection", () => {
  const r = new ValidatorRegistry();
  for (const bad of [{ ...provider(), apiVersion: 2 }, { ...provider(), version: 0 }, { ...provider(), version: 1.5 },
    { ...provider(), name: "../invalid" }, { ...provider(), assess: undefined }]) assert.throws(() => r.register(bad as ValidatorProvider));
  r.register(provider());
  assert.throws(() => r.register(provider()), /Duplicate/);
  assert.equal(r.current, undefined);
  r.select("dedicated");
  assert.equal(r.current?.name, "dedicated");
  assert.deepEqual(r.versions(), [{ name: "dedicated", version: 1, apiVersion: 1 }]);
  r.select(false); assert.equal(r.current, undefined);
  assert.throws(() => r.select("../bad"));
});

test("real plugin registers replaceable legacy judge through PluginAPI", async () => {
  const host = new PluginHost();
  await host.load([], { agent: "test", home: "/tmp", cwd: "/tmp" }, [], [], [validatorPlugin]);
  assert.equal(host.validators.current?.name, "legacy-llm");
  assert.deepEqual(await assess(host.validators), { state: "completed" });
  await host.stop();
});

test("selection enabled, disabled and unavailable never implicitly falls back", async () => {
  const r = new ValidatorRegistry(); r.register(legacyLLMProvider); r.register(provider());
  r.select("dedicated"); assert.deepEqual(await assess(r), { state: "completed" });
  r.select(false); assert.equal(await assess(r), undefined);
  r.select("missing"); assert.equal(await assess(r), undefined);
  r.register({ ...provider("error"), async assess() { throw Error("credential-secret"); } });
  r.select("error"); const diagnostics: string[] = [];
  assert.equal(await assessCompletion(backend, input(), "report", grant, signal(), undefined, () => 1000,
    completionPrompt, d => diagnostics.push(d), 1000, r), undefined);
  assert.deepEqual(diagnostics, ["technical"]);
});

test("task and delegated-step extraction parity and persisted continuation compatibility", async () => {
  const r = new ValidatorRegistry(); r.register(legacyLLMProvider);
  const answers = [{ state: "completed" }, { state: "waiting" }, { state: "blocked" },
    { state: "continue", next: "Run regression", contextPreparation: "handover", progress: { advanced: true, fingerprint: "test:one" } }];
  for (const answer of answers) for (const prompt of [completionPrompt, stepCompletionPrompt]) {
    const i = input(); i.completionContext = { task: grant.task };
    const b = { review: async () => JSON.stringify(answer) };
    const actual = await assessCompletion(b, i, "report", grant, signal(), undefined, () => 1000, prompt, undefined, 1000, r);
    const expected = { ...answer, ...(answer.state === "continue" ? { expiresAt: grant.expiresAt } : {}) };
    assert.deepEqual(actual, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, "legacy persisted shape unchanged");
  }
});

test("custom providers cannot bypass host authorization, API, stop, deadline or checkpoint fences", async () => {
  const r = new ValidatorRegistry(); let calls = 0;
  r.register({ ...provider(), async assess() { calls++; return { state: "completed" }; } }); r.select("dedicated");
  assert.equal(await assessCompletion(backend, input(), "report", undefined, signal(), undefined, () => 1000,
    completionPrompt, undefined, 1000, r), undefined);
  assert.equal(await assess(r, { ...input(), source: "api" }), undefined);
  assert.equal(await assess(r, input(), { ...grant, expiresAt: 1000 }), undefined);
  const abort = new AbortController(); abort.abort();
  assert.equal(await assess(r, input(), grant, abort.signal), undefined);
  assert.equal(calls, 0);
  r.register({ ...provider("changes-checkpoint"), async assess({ input }) {
    input.continuation = { state: "blocked" }; return { state: "completed" };
  } }); r.select("changes-checkpoint");
  assert.equal(await assess(r), undefined);
});

test("provider responses remain bounded and schema checked; unavailable or uncertain is never success", async () => {
  for (const result of [undefined, null, [], "completed", { state: "uncertain" }, { state: "success" },
    { state: "continue", next: "" }, { state: "continue", next: "x", contextPreparation: "skip" }]) {
    const r = new ValidatorRegistry(); r.register({ ...provider(), async assess() { return result; } }); r.select("dedicated");
    assert.equal(await assess(r), undefined);
  }
});

test("noncooperative provider is time bounded; abort and expiry cannot produce success", async () => {
  const r = new ValidatorRegistry(); let aborted = false;
  r.register({ ...provider(), async assess({ signal }) { signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); } });
  r.select("dedicated");
  assert.equal(await assessCompletion(backend, input(), "report", grant, signal(), undefined, () => 1000, completionPrompt, undefined, 10, r), undefined);
  assert.equal(aborted, true);
});
