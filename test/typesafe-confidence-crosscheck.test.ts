import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ValidatorRegistry } from "../src/validator.js";
import { PluginHost } from "../src/plugins.js";
import { assessCompletion } from "../src/completion-check.js";
import { typeSafeDecisionPlugin, createTypeSafeAPIPlugin, typeSafeMinConfidence, DEFAULT_TYPESAFE_MIN_CONFIDENCE, TYPESAFE_VALIDATOR } from "../src/typesafe-decisions.js";

/** Real loopback SystemOne transport answering one fixed choice/confidence. */
async function fixture(t: import("node:test").TestContext, choice: string, confidence: number, minConfidence?: number) {
  const home = await mkdtemp(path.join(os.tmpdir(), "typesafe-floor-"));
  const file = path.join(home, "token"); await writeFile(file, "synthetic-token", { mode: 0o600 });
  let requests = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests++;
    const parsed = JSON.parse(body); const id = Object.keys(parsed.questions)[0]!;
    const keys = Object.keys(parsed.questions[id].criteria);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "openjev-latest", answers: { [id]: { type: "choice", choice, confidence,
      probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) } } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1/systemone`;
  const host = new PluginHost(); host.validators.select(TYPESAFE_VALIDATOR);
  await host.load([], { agent: "test", home, cwd: home }, [], [], [typeSafeDecisionPlugin,
    createTypeSafeAPIPlugin({ endpoint, model: "openjev-latest", bearerTokenFile: file, timeoutMs: 2000, ...(minConfidence !== undefined ? { minConfidence } : {}) })]);
  t.after(async () => { await host.stop(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(home, { recursive: true, force: true }); });
  return { registry: host.validators, requests: () => requests };
}
const input = { id: "assessment", source: "host" as const, sessionKey: "mem:floor", text: "synthetic" };
const strategy = () => "bounded synthetic evidence; no new authority";
const run = (registry: Parameters<typeof assessCompletion>[9], crossCheck?: Parameters<typeof assessCompletion>[10], diagnostics: unknown[] = []) =>
  assessCompletion({ review: async () => { throw Error("primary backend must not run for a classifier"); } }, input, "report", { task: "synthetic scope" },
    new AbortController().signal, undefined, Date.now, strategy, (...d) => diagnostics.push(d), 2000, registry, crossCheck);

test("TypeSafe floor defaults to a sensible 0.8 and rejects nonsense values", () => {
  assert.equal(DEFAULT_TYPESAFE_MIN_CONFIDENCE, 0.8);
  assert.equal(typeSafeMinConfidence(undefined), 0.8);
  assert.equal(typeSafeMinConfidence(0.75), 0.75);
  for (const bad of [0.2, 0.95, 1, 1.5, Number.NaN, "0.8"]) assert.throws(() => typeSafeMinConfidence(bad));
});

test("Minerva 0.89 'done' is accepted at the default floor without any model call", async t => {
  const env = await fixture(t, "done", 0.8947);
  let judged = 0;
  const verdict = await run(env.registry, async () => { judged++; return undefined; });
  assert.equal(verdict?.state, "completed"); assert.equal(env.requests(), 1); assert.equal(judged, 0);
});

test("below the floor the configured model validator cross-checks once instead of asking Main", async t => {
  const env = await fixture(t, "done", 0.56);
  const prompts: string[] = []; const diagnostics: unknown[] = [];
  const verdict = await run(env.registry, async () => ({ model: "p/validator", backend: { review: async (prompt, model) => {
    prompts.push(`${model}:${prompt}`); return '{"state":"continue","next":"Post the missing summary comment on the issue."}'; } } }), diagnostics);
  assert.deepEqual(verdict && { state: verdict.state, next: verdict.next }, { state: "continue", next: "Post the missing summary comment on the issue." });
  assert.equal(prompts.length, 1); assert.match(prompts[0]!, /^p\/validator:bounded synthetic evidence/);
  assert.deepEqual(diagnostics, [], "a decided cross-check is not reported as inconclusive");
});

test("floor is relax-only: values above the pinned 0.9 are rejected at configuration time", () => {
  assert.equal(typeSafeMinConfidence(0.9), 0.9);
  for (const raised of [0.91, 0.95, 0.99]) assert.throws(() => typeSafeMinConfidence(raised), /between 0.5 and 0.9/);
  assert.throws(() => createTypeSafeAPIPlugin({ endpoint: "http://127.0.0.1:1/v1/systemone", model: "m", bearerTokenFile: "/x", minConfidence: 0.95 }), /between 0.5 and 0.9/);
});

test("an operator floor of 0.9 routes 0.89 to the cross-check", async t => {
  const env = await fixture(t, "done", 0.89, 0.9);
  let judged = 0;
  const verdict = await run(env.registry, async () => ({ model: "p/validator", backend: { review: async () => { judged++; return '{"state":"completed"}'; } } }));
  assert.equal(verdict?.state, "completed"); assert.equal(judged, 1); assert.equal(env.requests(), 1);
});

test("without a configured model judge, low confidence stays honestly inconclusive", async t => {
  const env = await fixture(t, "done", 0.56); const diagnostics: unknown[] = [];
  assert.equal(await run(env.registry, async () => undefined, diagnostics), undefined);
  assert.equal((diagnostics[0] as unknown[])[0], "inconclusive");
  assert.match(JSON.stringify(diagnostics), /low_confidence; selected done, confidence 0.56/);
});

test("an uncertain cross-check stays inconclusive; nothing is invented", async t => {
  const env = await fixture(t, "more", 0.6); const diagnostics: unknown[] = [];
  const verdict = await run(env.registry, async () => ({ model: "p/validator", backend: { review: async () => '{"state":"uncertain"}' } }), diagnostics);
  assert.equal(verdict, undefined); assert.equal((diagnostics[0] as unknown[])[0], "inconclusive");
});

test("an explicit 'unknown' classifier choice is never re-admitted by the floor", async t => {
  const env = await fixture(t, "unknown", 0.99); let judged = 0;
  const verdict = await run(env.registry, async () => ({ model: "p/validator", backend: { review: async () => { judged++; return '{"state":"blocked"}'; } } }));
  assert.equal(verdict?.state, "blocked", "model judge decides"); assert.equal(judged, 1);
});

test("cross-check reuses the classifier's exact frozen prompt, not a second rendering", async () => {
  const registry = new ValidatorRegistry();
  let classifierPrompt = ""; let modelPrompt = ""; let renders = 0;
  registry.register({ apiVersion: 1, name: "classifier", version: 1, requiresModel: false, maxPromptBytes: 24000,
    async assess(request) { classifierPrompt = request.promptText; return { state: "uncertain" }; } });
  registry.select("classifier");
  const verdict = await assessCompletion({ review: async () => { throw Error("classifier does not use a model"); } },
    input, "report", { task: "scope" }, new AbortController().signal, undefined, Date.now,
    () => `scope and evidence snapshot ${++renders}`, undefined, 2000, registry,
    async () => ({ model: "p/validator", backend: { review: async prompt => { modelPrompt = prompt; return '{"state":"completed"}'; } } }));
  assert.equal(verdict?.state, "completed");
  assert.equal(renders, 1); assert.equal(modelPrompt, classifierPrompt);
});
