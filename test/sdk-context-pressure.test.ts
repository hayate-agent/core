import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";
import { contextPolicy } from "../src/context-maintenance.js";

for (const usage of [12000, 0, 100000]) test(`real SDK pressure follows token usage, not 49KB JSON; usage=${usage}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "sdk-pressure-"));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  });
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  let requests = 0, compactions = 0;
  models.registerProvider("pressure-fixture", { api: "openai-completions", baseUrl: "https://offline.invalid", apiKey: "offline",
    models: [{ id: "model", name: "Pressure fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 8192,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model) => {
      requests++; const stream = createAssistantMessageEventStream();
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "Read-only observation, uncertain remote effects remain uncertain." }],
        stopReason: "stop", timestamp: Date.now(), usage: { input: usage, output: usage ? 20 : 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: usage ? usage + 20 : 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); }); return stream;
    } });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), model: "pressure-fixture/model", tools: [], skillPaths: [],
    personaSections: async () => [], contextBudgets: () => contextPolicy({ mainContextTokens: 65536, workerContextTokens: 65536 }),
    compactionOwner: () => "agent", approvals: { mode: "off", tools: [] } });
  (runtime as any).modelRuntime = async () => models;
  const wrapped: any = await runtime.open("main");
  try {
    wrapped.session.subscribe((event: any) => { if (event.type === "compaction_start") compactions++; });
    if (usage === 100000) await wrapped.prompt("Earlier fixture task checkpoint. Preserve completed effects and uncertain outcomes.");
    await wrapped.prompt("Read-only fixture data: " + "ordinary evidence ".repeat(usage === 100000 ? 20000 : 2800));
    await wrapped.prompt("Continue inspecting this same evidence, do not repeat effects.");
    if (usage === 100000) {
      assert(compactions > 0, "genuine high provider token usage still triggers native maintenance");
      assert(requests > 2, "real pressure is not suppressed to make the low-pressure test pass");
      return;
    }
    assert.equal(requests, 2, "no surprise summary-model request");
    assert.equal(compactions, 0, "JSON byte length must not force a zero-token native threshold");
    const status = wrapped.status();
    assert.equal(status.contextEstimateBasis, "sdk-context");
    assert(status.contextEstimateTokens < 20000, "tokens/estimate, not the approximately 49KB JSON length");
    assert(status.contextBudgetPercent < 35);
    assert.equal(wrapped.session.model.contextWindow - wrapped.session.settingsManager.getCompactionSettings(wrapped.session.model).reserveTokens, 65536);
    wrapped.session.getContextUsage = () => ({ tokens: null, percent: null, contextWindow: 131072 });
    const fallback = wrapped.status();
    assert.equal(fallback.contextEstimateBasis, "heuristic", "unknown post-compaction counters are not fabricated provider usage");
    assert(fallback.contextEstimateTokens > 10000 && fallback.contextEstimateTokens < 25000, "fallback converts bytes into approximate tokens, not a hard admission gate");
  } finally { await wrapped.dispose(); }
});
