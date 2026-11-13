import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginHost, type PluginModule } from "../src/plugins.js";
import { Harness } from "../src/harness.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { assessCompletion } from "../src/completion-check.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { typeSafeDecisionPlugin, TYPESAFE_VALIDATOR, TYPESAFE_DISPATCHER, COMPLETION_BANK, DISPATCH_BANK, READY_BANK } from "../src/builtin-plugins/typesafe-decision-plugin.js";
import { createTypeSafeAPIPlugin, createTypeSafeAPI, TYPESAFE_STATE_BYTES, type ChoiceBank } from "../src/builtin-plugins/typesafe-api-plugin.js";
import { dispatcherConfig } from "../src/dispatcher-config.js";

const forbiddenBackend = { review: async () => { throw Error("No cloud/legacy fallback permitted"); } };
/** Real loopback HTTP wire mock, not the Java WireMock product. No external
 * service, credential, Docker pull, discovery or live inference is involved. */
async function fixture(t: import("node:test").TestContext, choice = "done", reverse = false, onRequest?: () => void) {
  const home = await mkdtemp(path.join(os.tmpdir(), "typesafe-decisions-"));
  const token = "synthetic-credential-not-a-real-secret";
  const file = path.join(home, "token"); await writeFile(file, token, { mode: 0o600 });
  const requests: Array<{ body: any; auth: string | undefined; path: string | undefined }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body); requests.push({ body: parsed, auth: req.headers.authorization, path: req.url });
    onRequest?.();
    const id = Object.keys(parsed.questions)[0]!;
    const readyMode = choice.startsWith("ready");
    if (choice === "failure" || (choice === "ready-failure" && id === READY_BANK.id)) { res.writeHead(503).end(token); return; }
    if (choice === "redirect") { res.writeHead(307, { location: "http://127.0.0.1:1/leak" }).end(); return; }
    const keys = Object.keys(parsed.questions[id].criteria);
    const selected = readyMode ? (id === READY_BANK.id ? choice === "ready-unknown" ? "unknown" : choice === "ready-none" ? "none" : "step_2" : parsed.state.includes("Synthetic first step blocked") ? "blocked" : "done") : choice === "low-confidence" ? "done" : choice;
    const lowConfidence = choice === "low-confidence" || (choice === "ready-low-confidence" && id === READY_BANK.id);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "openjev-latest", answers: { [id]: choice === "noul" || (choice === "ready-noul" && id === READY_BANK.id) ? { type: "noul", noul: 1 } : {
      type: "choice", choice: selected, confidence: lowConfidence ? 0.5 : 0.99, probabilities: Object.fromEntries(keys.map(k => [k, k === selected ? 1 : 0])),
      ...(choice === "injection" ? { stop: true } : {}),
    } }, usage: { input_tokens: 2, output_tokens: 1 } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/v1/systemone`;
  const config = { endpoint, model: "openjev-latest", bearerTokenFile: file, timeoutMs: 1000 };
  const host = new PluginHost();
  host.validators.select(TYPESAFE_VALIDATOR); host.dispatchDecisions.select(TYPESAFE_DISPATCHER);
  assert.throws(() => host.validators.current, /not registered/);
  assert.throws(() => host.dispatchDecisions.current, /not registered/);
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await host.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); });
  const attemptedBanks: string[] = [];
  const bankFault = choice.startsWith("bank-");
  // Test-only fault injection at the registered service boundary. Production
  // adapters still choose their own immutable banks; the REAL transport must
  // refuse corrupted bank policy before it can reach the listening wire mock.
  const transport: PluginModule = bankFault ? { apiVersion: 1, activate(api) {
    const wire = createTypeSafeAPI(config);
    api.registerService("typesafe-api", 1, { choose(bank: ChoiceBank, state: string, signal: AbortSignal) {
      attemptedBanks.push(bank.id);
      const invalid = choice === "bank-unknown-version" ? { ...bank, id: bank.id.replace(/_v1$/, "_v999") }
        : choice === "bank-unknown-id" ? { ...bank, id: "foreign_application_v1" }
        : { ...bank, choices: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`choice_${i}`, "over-limit"])) };
      return wire.choose(invalid, state, signal);
    } });
  } } : createTypeSafeAPIPlugin(config);
  const modules = [typeSafeDecisionPlugin, transport];
  await host.load([], { agent: "test", home, cwd: home }, [], [], reverse ? modules.reverse() : modules);
  assert.equal(requests.length, 0, "selection and activation must perform no provider I/O");
  return { host, requests, home, token, config, file, cleanups, bankFault, attemptedBanks };
}

function assertPrivateWire(env: Awaited<ReturnType<typeof fixture>>) {
  for (const req of env.requests) {
    assert.equal(req.path, "/v1/systemone");
    assert.equal(req.auth, `Bearer ${env.token}`);
    assert.deepEqual(Object.keys(req.body).sort(), ["model", "questions", "samples", "state"]);
    assert.equal(req.body.model, "openjev-latest");
    assert.equal(req.body.samples, 1);
    assert.ok(Buffer.byteLength(req.body.state) <= TYPESAFE_STATE_BYTES);
    const exported = JSON.stringify(req.body);
    assert.ok(!exported.includes(env.token));
    assert.ok(!exported.includes(env.file), "credential reference is host-only, not evidence");
    assert.ok(!exported.includes(env.home), "host home is not exported");
    assert.ok(!Object.hasOwn(req.body, "authorization"), "wire cannot grant authority");
  }
}

for (const consumer of ["Validator", "Dispatcher"]) test(`registered ${consumer} authority expiry during loopback response fails closed without fallback`, async t => {
  let now = 1, fallbackCalls = 0;
  const env = await fixture(t, "done", false, () => { now = 20001; });
  const registry = consumer === "Validator" ? env.host.validators : env.host.dispatchDecisions;
  const backend = { review: async () => { fallbackCalls++; throw Error("Forbidden fallback"); } };
  const input = { id: consumer === "Validator" ? "assessment" : "validate:synthetic:0", source: "host" as const, sessionKey: "mem:authority", text: "synthetic" };
  const authorization = { task: "synthetic scope only", expiresAt: 10001 };
  const diagnostics: unknown[] = [];
  const verdict = await assessCompletion(backend, input, "synthetic report", authorization, new AbortController().signal,
    undefined, () => now, () => "bounded synthetic evidence; no new authority", (...value) => diagnostics.push(value), 2000, registry);
  assert.equal(verdict, undefined, "a valid positive response cannot outlive host authorization");
  assert.equal(env.requests.length, 1);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(authorization, { task: "synthetic scope only", expiresAt: 10001 });
  assertPrivateWire(env);
  assert.ok(!JSON.stringify(diagnostics).includes(env.token));
});

for (const consumer of ["Validator", "Dispatcher"]) test(`registered ${consumer} bounded/private export rejects before loopback I/O`, async t => {
  const env = await fixture(t);
  const registry = consumer === "Validator" ? env.host.validators : env.host.dispatchDecisions;
  let fallbackCalls = 0;
  const backend = { review: async () => { fallbackCalls++; throw Error("Forbidden fallback"); } };
  const input = { id: consumer === "Validator" ? "assessment" : "validate:synthetic:0", source: "host" as const, sessionKey: "mem:privacy", text: "synthetic" };
  for (const prompt of ["x".repeat(TYPESAFE_STATE_BYTES + 1), "Authorization: Bearer synthetic-secret", `opaque ${env.token}`]) {
    assert.equal(await assessCompletion(backend, input, "synthetic", { task: input.text }, new AbortController().signal,
      undefined, Date.now, () => prompt, undefined, 1000, registry), undefined);
  }
  assert.equal(env.requests.length, 0, "refusal must occur before transport export");
  assert.equal(fallbackCalls, 0);
});

for (const reverse of [false, true]) test(`built registries and reverse bootstrap order ${reverse}`, async t => {
  const env = await fixture(t, "done", reverse);
  assert.equal(env.host.validators.current?.name, TYPESAFE_VALIDATOR);
  assert.equal(env.host.dispatchDecisions.current?.name, TYPESAFE_DISPATCHER);
  assert.equal(env.host.dispatchDecisions.current?.requiresModel, false);
  const input = { id: "assessment", sessionKey: "mem:room1", source: "host" as const, text: "Check synthetic work" };
  const verdict = await assessCompletion(forbiddenBackend, input, "Synthetic verification complete", { task: input.text }, new AbortController().signal,
    undefined, Date.now, completionPrompt, undefined, 2000, env.host.validators);
  assert.equal(verdict?.state, "completed");
  assert.equal(env.requests[0]!.body.questions[COMPLETION_BANK.id].type, "choice");
  assert.equal(env.requests[0]!.body.samples, 1);
  assert.equal(env.requests[0]!.path, "/v1/systemone");
  assert.equal(env.requests[0]!.auth, `Bearer ${env.token}`);
  assert.ok(!JSON.stringify(env.requests[0]!.body).includes(env.token));
  assert.ok(!JSON.stringify(env.host.validators.versions()).includes(env.token));
});

for (const choice of ["done", "blocked", "waiting", "unknown", "low-confidence", "failure", "noul", "injection", "redirect", "bank-unknown-version", "bank-unknown-id", "bank-over-limit"]) test(`actual Harness completion consumer over loopback: ${choice}`, async t => {
  const env = await fixture(t, choice);
  let checks = 0, fallbackCalls = 0;
  const backend = { review: async () => { fallbackCalls++; throw Error("Forbidden fallback"); } };
  let h!: Harness;
  const runtime = new FakeRuntime(() => { h.planContinuation("mem:room1", { state: "completed" }); return "Synthetic work verification report"; });
  h = new Harness({ runtime, home: env.home, tickMs: 60000, completionCheck: (input, reply, signal) => {
    checks++;
    return assessCompletion(backend, input, reply, { task: input.completionAnchor!.task }, signal, undefined, Date.now,
      completionPrompt, undefined, 2000, env.host.validators);
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  env.cleanups.push(() => h.stop(0));
  await h.submit(msg("Verify only the synthetic fixture")); await h.drained();
  assert.equal(checks, 1); assert.equal(env.requests.length, env.bankFault ? 0 : 1);
  if (env.bankFault) assert.deepEqual(env.attemptedBanks, [COMPLETION_BANK.id], "real completion adapter must reach the rejecting shared transport");
  assert.equal(fallbackCalls, 0);
  assertPrivateWire(env);
  assert.ok(!JSON.stringify(h.snapshotSessions()).includes(env.token), "provider error body/credential must not enter task diagnostics");
  const task = h.snapshotSessions()[0]!.tasks![0]!;
  if (choice === "done") assert.equal(task.state, "completed");
  else if (choice === "blocked" || choice === "waiting") assert.equal(task.state, choice);
  else assert.notEqual(task.state, "completed", "uncertain or technical failure must not endorse worker completion");
});

for (const choice of ["done", "blocked", "waiting", "unknown", "low-confidence", "failure", "noul", "injection", "redirect", "ready", "ready-none", "ready-unknown", "ready-low-confidence", "ready-failure", "ready-noul", "bank-unknown-version", "bank-unknown-id", "bank-over-limit"]) test(`actual sequential Dispatcher consumer over loopback: ${choice}`, async t => {
  const env = await fixture(t, choice);
  const readyMode = choice.startsWith("ready");
  let workers = 0, fallbackCalls = 0;
  const runtime = new FakeRuntime((_input, sessionKey) => {
    if (sessionKey.startsWith("plan:")) return JSON.stringify({ steps: (readyMode ? ["Verify synthetic fixture", "Verify independently ready fixture"] : ["Verify synthetic fixture"])
      .map(task => ({ task, role: "simple", reason: "bounded", evidence: "test evidence" })) });
    if (!sessionKey.startsWith("dispatch:")) { fallbackCalls++; throw Error("No runtime assessment fallback"); }
    workers++;
    if (readyMode && workers === 1) return "Synthetic first step blocked\nSTEP-STATUS: blocked: synthetic gate";
    return "Synthetic test evidence\nSTEP-STATUS: complete";
  });
  const originalOpen = runtime.open.bind(runtime);
  runtime.open = async (key, options) => {
    const session = await originalOpen(key, options);
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, opts = {}) => {
      opts.onEvent?.({ type: "execution", selection: { model: "test/worker", thinking: "low" } } as never);
      opts.onEvent?.({ type: "tool", name: "fixture", phase: "start", detail: "synthetic verification" } as never);
      opts.onEvent?.({ type: "tool", name: "fixture", phase: "end", detail: "synthetic verification passed" } as never);
      return prompt(text, opts);
    }; return session;
  };
  // No validator model registration: requiresModel=false must bypass legacy qualification.
  runtime.models = [{ provider: "test", id: "worker", name: "worker" }];
  (runtime as any).modelPreflight = async () => ({ available: true, thinkingSupported: true });
  const h = new Harness({ runtime, home: env.home, tickMs: 60000 });
  const store = new ExecutionStore(path.join(env.home, "executions")); await store.load();
  const bridge = new DispatcherRuntime(h, store, undefined, () => ({ config: { enabled: true, roles: { dispatcher: { model: "test/worker", thinking: "low" }, simple: { model: "test/worker", thinking: "low" } } }, defaults: { model: "test/worker", thinking: "low" } }), env.host.dispatchDecisions);
  h.addChannel(bridge.channel); h.onStateChange = async () => {};
  const errors: string[] = [];
  const dispatcher = new Dispatcher(store, bridge.sequential, 1, async () => {}, error => { errors.push(String((error as Error).stack)); });
  env.cleanups.push(async () => { await dispatcher.stop(); await h.stop(0); });
  await dispatcher.start();
  const row = await dispatcher.submit("mem:parent", "synthetic-request", "Verify the synthetic fixture without external effects");
  for (let n = 0; n < 300; n++) {
    const current = store.list().find(item => item.id === row.id)!;
    if (["completed", "failed", "paused", "blocked", "cancelled"].includes(current.status) || current.checkpoint?.includes('"nextAt"')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await dispatcher.waitForExecution(row.id);
  const saved = store.list().find(item => item.id === row.id)!;
  assert.equal(workers, choice === "ready" ? 2 : 1, `assessment failure must not rerun the worker: ${JSON.stringify(saved)} ${errors.join("\n")}`);
  if (env.bankFault) {
    assert.equal(env.requests.length, 0, "invalid bank policy must never cross the loopback wire");
    assert.ok(env.attemptedBanks.length >= 1);
    assert.ok(env.attemptedBanks.every(id => id === DISPATCH_BANK.id), "real Dispatcher adapter must reach the rejecting shared transport");
  } else {
    assert.ok(env.requests.length >= 1 && env.requests.length <= (readyMode ? 6 : 2), `wire requests=${env.requests.length}; ${JSON.stringify(saved)}; ${errors.join("\n")}`);
  }
  assert.equal(fallbackCalls, 0);
  assertPrivateWire(env);
  assert.ok(!JSON.stringify({ saved, errors }).includes(env.token), "provider error body/credential must not enter durable checkpoint or diagnostics");
  assert.ok(env.requests.every(req => Object.hasOwn(req.body.questions, DISPATCH_BANK.id) || (readyMode && Object.hasOwn(req.body.questions, READY_BANK.id))));
  if (readyMode && choice !== "ready") {
    assert.ok(env.requests.some(req => Object.hasOwn(req.body.questions, READY_BANK.id)), "failed ready decision must traverse its registered bank and wire");
    const checkpoint = JSON.parse(saved.checkpoint!);
    assert.equal(checkpoint.outcomes.length, 0, "failed/uncertain ready decision must not complete either step");
    assert.equal(checkpoint.plan.length, 2, "both original steps remain open");
    assert.match(checkpoint.plan[0].task, /^Verify synthetic fixture$/);
    assert.match(checkpoint.assessment.reply, /Synthetic first step blocked/, "first-step evidence remains held without worker replay");
    assert.equal(checkpoint.readyAdmission, undefined, "failure cannot grant ready admission");
  }
  if (choice === "ready") {
    assert.ok(env.requests.some(req => Object.hasOwn(req.body.questions, READY_BANK.id)), "ready selection must reach its own registered adapter bank");
    const checkpoint = JSON.parse(saved.checkpoint!);
    assert.equal(checkpoint.outcomes.length, 1, "only the independently selected second step is complete");
    assert.match(checkpoint.plan[0].task, /independently ready/);
    assert.match(checkpoint.assessment.reply, /Synthetic first step blocked/, "settled first-step evidence is retained, never replayed");
  }
  if (choice === "done") assert.equal(saved.status, "completed");
  else assert.notEqual(saved.status, "completed");
});

test("bounded/private exports, cancellation, expiry, credential references and no implicit provider fallback", async t => {
  const env = await fixture(t);
  const input = { id: "assessment", source: "host" as const, sessionKey: "mem:test", text: "synthetic" };
  for (const prompt of ["x".repeat(TYPESAFE_STATE_BYTES + 1), "Authorization: Bearer synthetic-secret", `secret=${env.token}`, `opaque ${env.token}`]) {
    assert.equal(await assessCompletion(forbiddenBackend, input, "synthetic", { task: input.text }, new AbortController().signal,
      undefined, Date.now, () => prompt, undefined, 1000, env.host.validators), undefined);
  }
  const controller = new AbortController(); controller.abort();
  assert.equal(await assessCompletion(forbiddenBackend, input, "synthetic", { task: input.text }, controller.signal, undefined, Date.now,
    completionPrompt, undefined, 1000, env.host.validators), undefined);
  assert.equal(await assessCompletion(forbiddenBackend, input, "synthetic", { task: input.text, expiresAt: 1 }, new AbortController().signal, undefined, Date.now,
    completionPrompt, undefined, 1000, env.host.validators), undefined);
  await chmod(env.file, 0o644);
  assert.equal(await assessCompletion(forbiddenBackend, input, "synthetic", { task: input.text }, new AbortController().signal, undefined, Date.now,
    completionPrompt, undefined, 1000, env.host.validators), undefined);
  assert.equal(env.requests.length, 0);
  assert.throws(() => createTypeSafeAPI({ ...env.config, endpoint: "http://external.invalid/v1/systemone" }));
  assert.throws(() => createTypeSafeAPI({ ...env.config, bearerToken: "do-not-inline" } as any));
  env.host.validators.select("missing"); assert.throws(() => env.host.validators.current, /not registered/);
  assert.equal(env.host.dispatchDecisions.current?.name, TYPESAFE_DISPATCHER, "consumer selection remains independent");
  env.host.dispatchDecisions.select(false); assert.equal(env.host.dispatchDecisions.current, undefined);
  assert.equal(dispatcherConfig({ decisionProvider: TYPESAFE_DISPATCHER }).decisionProvider, TYPESAFE_DISPATCHER);
  assert.throws(() => dispatcherConfig({ decisionProvider: "bad provider" }));
});
