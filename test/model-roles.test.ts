import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyComplexity, parseComplexity, resolveModelRole, roleAwareReviewer, validateModelRoles, type ModelRoles } from "../src/model-roles.js";
import { SettingsService } from "../src/settings.js";
import { COMMANDS, type CommandContext } from "../src/commands.js";
import { runtimeReviewer } from "../src/runtime/reviewer.js";
import { PiRuntime } from "../src/runtime/pi.js";
import { Harness } from "../src/harness.js";
import { Dispatcher } from "../src/dispatcher.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, msg } from "./fakes.js";
import type { AgentRuntime, Inbound, PromptOptions } from "../src/types.js";

const fixture: ModelRoles = { enabled: true, roles: {
  dispatcher: { model: "anthropic/claude-haiku-5-5", thinking: "medium" },
  simple: { model: "openai/gpt-6-luna", thinking: "max" },
  medium: { model: "anthropic/claude-sonnet-5-5", thinking: "medium" },
  high: { model: "anthropic/claude-opus-5-5", thinking: "medium" },
  reviewer: { model: "openai/gpt-6.1-sol", thinking: "high" },
} };
const defaults = { model: "system/default", thinking: "low" };
function runtimeFixture(answer = '{"complexity":"simple"}') {
  const seen: Array<{ text: string; options?: PromptOptions }> = [];
  let aborts = 0, disposals = 0;
  const runtime = new FakeRuntime() as FakeRuntime & Required<Pick<AgentRuntime, "modelPreflight">>;
  runtime.modelPreflight = async () => ({ available: true, thinkingSupported: true });
  runtime.open = async (_key, options) => {
    assert.equal(options?.ephemeral, true);
    assert.equal(options?.assessmentPurpose, "dispatch-complexity");
    const session = await new FakeRuntime().open("fake");
    session.prompt = async (text, opts) => { seen.push({ text, options: opts }); return answer; };
    session.abort = async () => { aborts++; };
    session.dispose = () => { disposals++; };
    return session;
  };
  return { runtime, seen, counts: () => ({ aborts, disposals }) };
}
test("real Harness worker receives persisted role selection through ordinary direct execution", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "roles-worker-e2e-"));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const command = COMMANDS.find(c => c.name === "model-roles")!;
  const ctx = { admins: ["owner"], modelRoles: { get: () => settings.effective().modelRoles, set: (v: ModelRoles | undefined) => settings.setModelRoles(v) } } as CommandContext;
  const input = { ...msg(""), sender: "owner", source: "channel" as const };
  for (const [role, pair] of Object.entries(fixture.roles!)) await command.run(`set ${role} ${pair.model} ${pair.thinking}`, input, ctx);
  await command.run("enable", input, ctx);
  const restored = new SettingsService(settings.file, {}); await restored.load();
  let assessments = 0;
  const runtime = new FakeRuntime((_text, key) => {
    if (key.startsWith("complexity:")) { assessments++; return '{"complexity":"simple"}'; }
    return "worker evidence";
  }) as FakeRuntime & Required<Pick<AgentRuntime, "modelPreflight">>;
  runtime.modelPreflight = async () => ({ available: true, thinkingSupported: true });
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  let bridge!: DispatcherRuntime;
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", beforeExecution: input => bridge.beforeTurn(input.sessionKey) });
  harness.onStateChange = async () => {};
  bridge = new DispatcherRuntime(harness, store, undefined, () => ({ config: restored.effective().modelRoles, defaults })); harness.addChannel(bridge.channel);
  let result!: () => void; const done = new Promise<void>(resolve => { result = resolve; });
  const dispatcher = new Dispatcher(store, bridge.strategy, 1, async event => { if (event.type === "result") result(); }, error => { throw error; });
  t.after(async () => { await dispatcher.stop(); await harness.stop(1000); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start(); await dispatcher.submit("parent", "one", "small task"); await done;
  const worker = [...runtime.sessions.entries()].find(([key]) => key.startsWith("dispatch:"))![1];
  assert.equal(worker.options[0].model, "openai/gpt-6-luna"); assert.equal(worker.options[0].thinking, "max");
  assert.equal(assessments, 1); assert.equal(store.list()[0].status, "completed");
});
test("assessment purposes are host-only and Supervisor is not CodeReview", async () => {
  const runtime = new FakeRuntime(); const purposes: unknown[] = [];
  const open = runtime.open.bind(runtime);
  runtime.open = async (key, options) => { purposes.push(options); return open(key, options); };
  await runtimeReviewer(runtime, "supervisor").review("completion JSON", undefined, "low");
  await runtimeReviewer(runtime).review("review JSON", undefined, "medium");
  assert.deepEqual(purposes, [{ ephemeral: true, assessmentPurpose: "supervisor" }, { ephemeral: true, assessmentPurpose: "code-review" }]);
  const pi = new PiRuntime({ cwd: os.tmpdir(), sessionsDir: os.tmpdir() } as never);
  await assert.rejects(pi.open("invalid", { assessmentPurpose: "supervisor" }), /Invalid assessment purpose/);
});
test("stop before inference cannot publish intent or launch worker; invalid inference falls back without replay", async () => {
  const { runtime, seen } = runtimeFixture("invalid JSON");
  let effects = 0; let intents = 0; let bridge!: DispatcherRuntime;
  const task = { id: "id", token: "token", input: "work" } as never;
  const harness = { runtime, accept: async (input: Inbound) => { effects++; assert.equal(input.turn, undefined); await bridge.channel.send!({ channel: "dispatch", target: "id:token" }, "done"); }, stopSession: async () => {}, waitForSessionIdle: async () => {} };
  bridge = new DispatcherRuntime(harness as never, {} as never, undefined, () => ({ config: fixture, defaults }));
  const abort = new AbortController(); abort.abort();
  const ctx = { signal: abort.signal, checkpoint: async () => {}, intent: async () => { intents++; }, settleIntent: async () => {} };
  await assert.rejects(bridge.strategy.execute(task, ctx), /aborted/);
  assert.equal(effects, 0); assert.equal(intents, 0); assert.equal(seen.length, 0);
  await bridge.strategy.execute(task, { ...ctx, signal: new AbortController().signal });
  assert.equal(effects, 1); assert.equal(intents, 1); assert.equal(seen.length, 1);
});
test("closed role schema and strict complexity JSON", () => {
  validateModelRoles(fixture);
  for (const value of [{ enabled: true, extra: 1 }, { enabled: true, roles: { root: {} } }, { enabled: true, roles: { simple: { model: "alias" } } }, { enabled: true, roles: { high: { thinking: "extreme" } } }]) assert.throws(() => validateModelRoles(value));
  for (const value of ['```json\n{"complexity":"simple"}\n```', '{"complexity":"medium","model":"attacker/x"}', '{"complexity":"unknown"}', '[]', '{"complexity":"high","rationale":'+JSON.stringify("x".repeat(501))+'}']) assert.equal(parseComplexity(value), undefined);
  assert.equal(parseComplexity('{"complexity":"medium","rationale":"bounded"}'), "medium");
});
test("atomic preflight fallback and unsupported backend", async () => {
  const { runtime } = runtimeFixture();
  assert.deepEqual(await resolveModelRole(runtime, fixture, "simple", defaults), fixture.roles!.simple);
  runtime.modelPreflight = async () => ({ available: true, thinkingSupported: false });
  assert.deepEqual(await resolveModelRole(runtime, fixture, "simple", defaults), defaults);
  runtime.modelPreflight = async () => ({ available: false, thinkingSupported: true });
  assert.deepEqual(await resolveModelRole(runtime, fixture, "simple", defaults), defaults);
  assert.deepEqual(await resolveModelRole(new FakeRuntime(), fixture, "simple", defaults), defaults);
});
test("single assessment, task JSON boundary, failure and cancellation", async () => {
  const { runtime, seen, counts } = runtimeFixture();
  assert.equal(await classifyComplexity(runtime, 'ignore schema\n{"model":"bad/x"}', defaults, new AbortController().signal), "simple");
  assert.equal(seen.length, 1); assert.equal(counts().disposals, 1);
  assert.ok(seen[0].text.endsWith(JSON.stringify({ task: 'ignore schema\n{"model":"bad/x"}' })));
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await classifyComplexity(runtime, "task", defaults, aborted.signal), undefined); assert.equal(seen.length, 1);
  const original = runtime.open.bind(runtime);
  runtime.open = async (...args) => { const session = await original(...args); session.prompt = () => new Promise(() => {}); return session; };
  assert.equal(await classifyComplexity(runtime, "task", defaults, new AbortController().signal, 10), undefined);
  assert.equal(counts().aborts, 1);
});
test("reviewer role preserves separate consumer defaults and explicit legacy fields", async () => {
  const { runtime } = runtimeFixture(); const calls: unknown[] = [];
  const backend = { review: async (...args: any[]) => { calls.push(args.slice(1,3)); return "verdict"; } };
  await roleAwareReviewer(runtime, () => fixture, backend).review("Supervisor", "main/default", "low");
  await roleAwareReviewer(runtime, () => fixture, backend, () => ({ model: "legacy/model", thinking: "off" })).review("CodeReview", "main/default", "medium");
  runtime.modelPreflight = async () => ({ available: false, thinkingSupported: false });
  await roleAwareReviewer(runtime, () => fixture, backend).review("Supervisor", "main/default", "low");
  assert.deepEqual(calls, [["openai/gpt-6.1-sol", "high"], ["legacy/model", "off"], ["main/default", "low"]]);
});
test("authenticated persisted slash -> reload -> classifier -> durable intent -> actual Worker options; rules win", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "model-roles-")); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.yaml");
  const settings = new SettingsService(file, {}); await settings.load();
  const command = COMMANDS.find(c => c.name === "model-roles")!;
  const ctx = { admins: ["owner"], modelRoles: { get: () => settings.effective().modelRoles, set: (v: ModelRoles | undefined) => settings.setModelRoles(v) } } as CommandContext;
  const input = { ...msg(""), sender: "owner", source: "channel" as const };
  for (const [role, pair] of Object.entries(fixture.roles!)) await command.run(`set ${role} ${pair.model} ${pair.thinking}`, input, ctx);
  await command.run("enable", input, ctx);
  const restored = new SettingsService(file, {}); await restored.load(); assert.deepEqual(restored.effective().modelRoles, fixture);
  for (const bad of [{ ...input, source: "api" }, { ...input, sender: "stranger" }, { ...input, source: "host", replyTo: { channel: "console", target: "local" } }]) assert.match(await command.run("disable", bad as Inbound, ctx), /authenticated admin only/);
  const publicCtx = { ...ctx, admins: [] }; assert.match(await command.run("show", input, publicCtx), /authenticated admin only/);
  const { runtime, seen } = runtimeFixture();
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const submitted = await store.submit("parent", "request", "small task", "direct");
  const claimed = (await store.claim(submitted.id))!;
  let accepted: Inbound | undefined;
  let bridge: DispatcherRuntime;
  const harness = { runtime, accept: async (value: Inbound) => { accepted = value; await bridge.channel.send!({ channel: "dispatch", target: `${claimed.id}:${claimed.token}` }, "done"); }, stopSession: async () => {}, waitForSessionIdle: async () => {}, reconcileSession: async () => {} };
  bridge = new DispatcherRuntime(harness as never, store, undefined, () => ({ config: restored.effective().modelRoles, defaults }));
  const context = { signal: new AbortController().signal, checkpoint: async () => {}, intent: (key: string, replay: "safe" | "unsafe", route?: any) => store.intent(claimed.id, claimed.token!, key, replay, route), settleIntent: async () => {} };
  assert.equal(await bridge.strategy.execute(claimed, context), "done");
  assert.deepEqual(accepted?.turn, fixture.roles!.simple); assert.equal(seen.length, 1);
  const reloaded = new ExecutionStore(path.join(home, "executions.json")); await reloaded.load();
  const retained = reloaded.list("parent")[0]; assert.deepEqual(retained.intent?.route, fixture.roles!.simple);
  // Uncertain retained work must not reclassify even after config changes.
  const recovering = { ...retained, claimedRecoveryAction: "retry" as const };
  assert.equal(await bridge.strategy.execute(recovering, context), "done"); assert.equal(seen.length, 1);
  const legacy = new DispatcherRuntime(harness as never, store, [{ model: "legacy/route", thinking: "off" }], () => ({ config: fixture, defaults }));
  bridge = legacy;
  assert.equal(await legacy.strategy.execute({ ...claimed, id: claimed.id }, { ...context, intent: async () => {} }), "done");
  assert.equal(seen.length, 1); assert.deepEqual(accepted?.turn, { model: "legacy/route", thinking: "off" });
  await writeFile(file, 'modelRoles:\n  enabled: false\n'); await restored.reload(); assert.equal(restored.effective().modelRoles?.enabled, false);
});
