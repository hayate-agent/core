import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";
import { pruningPolicy } from "../src/tool-result-pruning.js";
import { pruneToolResults } from "../src/builtin-plugins/tool-result-projector.js";
import { FilesystemSessionProvider } from "../src/sessions.js";
const { convertMessages } = await import(new URL("api/openai-completions.js", import.meta.resolve("@earendil-works/pi-ai")).href);

for (const external of [false, true]) test(`tool budget projection preserves the actual wire prefix across age thresholds and resume (${external ? "external" : "native"})`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-contract-runtime-")); t.after(() => rm(home, { recursive: true, force: true }));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const models = await ModelRuntime.create({ refreshOnCreate: false }); let requests = 0, effects = 0, indexed = 0, target = 18;
  let previousWire: any[] | undefined;
  const provider = new FilesystemSessionProvider(path.join(home, "store"));
  await models.setRuntimeApiKey("context-contract-fixture", "offline");
  models.registerProvider("context-contract-fixture", { api: "openai-completions", baseUrl: "https://offline.invalid", models: [{
    id: "model", name: "Context fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple: (model, context) => {
    requests++;
    const wire = convertMessages(model, context, { supportsMidConvoSystemMessages: false, supportsDeveloperRole: false });
    if (previousWire) assert.deepEqual(wire.slice(0, previousWire.length), previousWire, "later results/budget/keepRecent/reopen must never rewrite sent history");
    previousWire = structuredClone(wire);
    assert.match(JSON.stringify(context), /# Tool results and retained context/);
    assert.match(JSON.stringify(context), /Never rerun a completed or uncertain operation merely to recover its output/);
    const results: any[] = context.messages.filter((m: any) => m.role === "toolResult");
    if (results.some(m => JSON.stringify(m.content).includes("Complete original at"))) indexed++;
    for (const result of results) assert(context.messages.some((m: any) => m.role === "assistant" && m.content.some((p: any) => p.type === "toolCall" && p.id === result.toolCallId)));
    const next = results.length, stream = createAssistantMessageEventStream();
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: next < target ? [{ type: "toolCall", id: `call-${next}`, name: "plugin_sample", arguments: {} }]
        : [{ type: "text", text: "Observations retained. Unknown remote effects remain unknown; no operation replayed." }],
      stopReason: next < target ? "toolUse" : "stop", usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 1020,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }); return stream;
  } });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), model: "context-contract-fixture/model", tools: ["plugin_sample"], skillPaths: [],
    pruning: () => pruningPolicy({ proactivePruneTokens: 1024, keepRecent: 2 }), projectToolResults: pruneToolResults,
    ...(external ? { sessionProvider: () => provider } : {}), personaSections: async () => ["Exact operator rule: do not deploy."],
    approvals: { mode: "off", tools: [] }, pluginTools: () => [{ name: "plugin_sample", description: "Synthetic observation", parameters: { type: "object", properties: {} },
      execute: async () => { effects++; return "Reported observation, not proof of external state. " + "small evidence ".repeat(100); } }] });
  (runtime as any).modelRuntime = async () => models;
  for (const key of ["main", "dispatch:fixture:claim", "subagent:fixture"]) {
    previousWire = undefined; target = 18;
    let session: any = await runtime.open(key);
    session.session.settingsManager.setCompactionEnabled(false);
    try {
      assert.match(await session.prompt("Collect synthetic observations, then summarize findings without replay."), /Unknown remote effects/);
      target = 20;
      await session.prompt("Collect two more observations.");
      const id = session.status().sessionId;
      await session.dispose();
      session = await runtime.open(key);
      session.session.settingsManager.setCompactionEnabled(false);
      assert.equal(session.status().sessionId, id);
      target = 22;
      await session.prompt("Resume with two more observations.");
      assert.equal(session.session.sessionManager.getEntries().filter((e: any) => e.type === "message" && e.message.role === "toolResult").length, 22);
    } finally { await session.dispose(); }
  }
  assert.equal(effects, 66); assert.equal(requests, 75, "only ordinary working/model calls; no extra summary model"); assert(indexed >= 3);
});
