import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";
import { pruningPolicy } from "../src/tool-result-pruning.js";

test("actual SDK Main/dispatcher worker/subagent apply the result contract and accumulate references, not repeated payloads", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-contract-runtime-")); t.after(() => rm(home, { recursive: true, force: true }));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const models = await ModelRuntime.create({ refreshOnCreate: false }); let requests = 0, effects = 0, indexed = 0;
  models.registerProvider("context-contract-fixture", { api: "openai-completions", baseUrl: "https://offline.invalid", apiKey: "offline", models: [{
    id: "model", name: "Context fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple: (model, context) => {
    requests++;
    assert.match(JSON.stringify(context), /# Tool results and retained context/);
    assert.match(JSON.stringify(context), /Never rerun a completed or uncertain operation merely to recover its output/);
    const results: any[] = context.messages.filter((m: any) => m.role === "toolResult");
    if (results.some(m => JSON.stringify(m.content).includes("Older tool evidence index:"))) indexed++;
    for (const result of results) assert(context.messages.some((m: any) => m.role === "assistant" && m.content.some((p: any) => p.type === "toolCall" && p.id === result.toolCallId)));
    const next = results.length, stream = createAssistantMessageEventStream();
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: next < 9 ? [{ type: "toolCall", id: `call-${next}`, name: "plugin_sample", arguments: {} }]
        : [{ type: "text", text: "Nine observations retained. Unknown remote effects remain unknown; no operation replayed." }],
      stopReason: next < 9 ? "toolUse" : "stop", usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 1020,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }); return stream;
  } });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), model: "context-contract-fixture/model", tools: ["plugin_sample"], skillPaths: [],
    pruning: () => pruningPolicy({ proactivePruneTokens: 1024, keepRecent: 2 }), personaSections: async () => ["Exact operator rule: do not deploy."],
    approvals: { mode: "off", tools: [] }, pluginTools: () => [{ name: "plugin_sample", description: "Synthetic observation", parameters: { type: "object", properties: {} },
      execute: async () => { effects++; return "Reported observation, not proof of external state. " + "small evidence ".repeat(100); } }] });
  (runtime as any).modelRuntime = async () => models;
  for (const key of ["main", "dispatch:fixture:claim", "subagent:fixture"]) {
    const session: any = await runtime.open(key);
    try {
      assert.match(await session.prompt("Collect nine synthetic observations, then summarize findings without replay."), /Unknown remote effects/);
      assert.equal(session.session.sessionManager.getEntries().filter((e: any) => e.type === "message" && e.message.role === "toolResult").length, 9);
    } finally { await session.dispose(); }
  }
  assert.equal(effects, 27); assert.equal(requests, 30, "only ordinary working/model calls; no extra summary model"); assert(indexed >= 3);
});
