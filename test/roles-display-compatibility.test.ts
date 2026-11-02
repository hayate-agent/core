import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";
import { COMMANDS, type CommandContext } from "../src/commands.js";
import { Harness } from "../src/harness.js";
import { Dispatcher } from "../src/dispatcher.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import { PiSession } from "../src/runtime/pi.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { ActivityEvent } from "../src/activity.js";
import type { AgentRuntime } from "../src/types.js";

for (const available of [true, false]) test(`persisted role + actual PI display: ${available ? "SDK clamp" : "unavailable pair fallback"}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "roles-display-"));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const command = COMMANDS.find(c => c.name === "model-roles")!;
  const ctx = { admins: ["owner"], modelRoles: { get: () => settings.effective().modelRoles, set: v => settings.setModelRoles(v) } } as CommandContext;
  const input = { ...msg(""), sender: "owner", source: "channel" as const };
  await command.run("set dispatcher p/classifier low", input, ctx);
  await command.run("set simple p/worker high", input, ctx);
  await command.run("enable", input, ctx);
  const restored = new SettingsService(settings.file, {}); await restored.load();
  const A = { provider: "p", id: "default" }, B = { provider: "p", id: "worker" };
  let listener: (event: unknown) => void = () => {};
  const observed: Array<{ model: unknown; thinking: string }> = [];
  const agent = {
    model: A, thinkingLevel: "low", messages: [] as unknown[],
    isStreaming: false, systemPrompt: "", tools: [],
    async waitForIdle() {},
    getContextUsage: () => ({ tokens: 0, contextWindow: 100000, percent: 0 }),
    getSessionStats: () => ({ messages: 0, tokens: { total: 0 }, cost: 0 }),
    async setModel(model: typeof A) { agent.model = model; if (model === B) agent.thinkingLevel = "off"; },
    setThinkingLevel(value: string) { agent.thinkingLevel = agent.model === B ? "off" : value; },
    subscribe(fn: typeof listener) { listener = fn; return () => {}; },
    async prompt() { observed.push({ model: agent.model, thinking: agent.thinkingLevel }); agent.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] }); listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "done" } }); },
    async abort() {}, dispose() {},
  };
  const runtime = new FakeRuntime() as FakeRuntime & Required<Pick<AgentRuntime, "modelPreflight">>;
  runtime.modelPreflight = async model => ({ available: model !== "p/worker" || available, thinkingSupported: true });
  const open = runtime.open.bind(runtime); let classifications = 0;
  runtime.open = async (key, options) => {
    if (key.startsWith("complexity:")) {
      assert.deepEqual(options, { ephemeral: true, assessmentPurpose: "dispatch-complexity" });
      const session = await open(key, options);
      session.prompt = async (_text, opts) => { classifications++; assert.equal(opts?.model, "p/classifier"); return '{"complexity":"simple"}'; };
      return session;
    }
    return new PiSession(agent as never, { getAll: () => [A, B], getModel: (p: string, id: string) => [A, B].find(m => m.provider === p && m.id === id) } as never, {});
  };
  const file = path.join(home, "executions.json"), store = new ExecutionStore(file); await store.load();
  let bridge!: DispatcherRuntime;
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", beforeExecution: input => bridge.beforeTurn(input.sessionKey) });
  harness.onStateChange = async () => {};
  const channel = new MemoryChannel(), activity: ActivityEvent[] = [];
  Object.assign(channel, { taskActivity: (_to: unknown, event: ActivityEvent) => activity.push(event) });
  harness.addChannel(channel); harness.state("parent").replyTo = { channel: "mem", target: "room" };
  bridge = new DispatcherRuntime(harness, store, undefined, () => ({ config: restored.effective().modelRoles, defaults: { model: "p/default", thinking: "low" } }));
  harness.addChannel(bridge.channel);
  let done!: () => void; const finished = new Promise<void>(resolve => { done = resolve; });
  const dispatcher = new Dispatcher(store, bridge.strategy, 1, async event => { if (event.type === "result") done(); }, error => { throw error; });
  t.after(async () => { await dispatcher.stop(); await harness.stop(1000); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start(); await dispatcher.submit("parent", "one", "small task"); await finished;
  const selection = available ? { model: "p/worker", thinking: "off" } : { model: "p/default", thinking: "low" };
  assert.deepEqual(observed, [{ model: available ? B : A, thinking: selection.thinking }]);
  assert.equal(agent.model, A); assert.equal(agent.thinkingLevel, "low");
  assert.equal(classifications, 1);
  const retained = new ExecutionStore(file); await retained.load();
  assert.deepEqual(retained.list()[0].execution, selection);
  assert.equal(retained.list()[0].status, "completed");
  assert.ok(activity.some(event => JSON.stringify(event.snapshot.execution) === JSON.stringify(selection)));
  assert.ok(activity.filter(event => event.snapshot.execution).every(event => event.snapshot.execution?.model !== "p/classifier"));
});
