import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";

test("actual SDK releases a completed model response before a tool's nested same-model request", { timeout: 10000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "admission-reentrant-")); t.after(() => rm(home, { recursive: true, force: true }));
  const models = await ModelRuntime.create({ refreshOnCreate: false }); let calls = 0, tools = 0;
  models.registerProvider("admission-reentrant", { api: "openai-completions", baseUrl: "https://offline.invalid/v1", apiKey: "offline",
    models: [{ id: "shared", name: "fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context) => {
      calls++;
      const child = JSON.stringify(context.messages).includes("fixture nested child");
      const settled = context.messages.some(m => m.role === "toolResult");
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: child || settled ? [{ type: "text", text: child ? "child done" : "parent done" }]
          : [{ type: "toolCall", id: "fixture-nested-call", name: "plugin_nested", arguments: {} }],
        stopReason: child || settled ? "stop" : "toolUse",
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const response = createAssistantMessageEventStream();
      queueMicrotask(() => { response.push({ type: "done", reason: message.stopReason, message }); response.end(); });
      return response;
    },
  });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), model: "admission-reentrant/shared",
    tools: ["plugin_nested"], skillPaths: [], personaSections: async () => [], approvals: { mode: "off", tools: [] },
    localModelScheduling: [{ model: "admission-reentrant/shared", concurrency: 1 }],
    pluginTools: () => [{ name: "plugin_nested", description: "Offline nested fixture", parameters: { type: "object", properties: {} },
      execute: async () => { tools++; const child = await runtime.open("subagent:reentrant");
        try { return await child.prompt("fixture nested child"); } finally { await child.dispose(); } } }],
  });
  (runtime as any).modelRuntime = async () => models;
  const parent = await runtime.open("matrix:reentrant"); t.after(async () => { await parent.abort(); await parent.dispose(); });
  assert.equal(await parent.prompt("fixture parent"), "parent done"); assert.equal(calls, 3); assert.equal(tools, 1);
});

test("an unresolved explicit scheduling rule is not silently treated as unrestricted", async () => {
  const runtime = new PiRuntime({ cwd: os.tmpdir(), sessionsDir: os.tmpdir(), skillPaths: [], tools: [], personaSections: async () => [],
    approvals: { mode: "off", tools: [] }, localModelScheduling: [{ model: "missing/model", concurrency: 1 }] });
  (runtime as any).modelRuntime = async () => ({ getPhysicalModel: () => undefined });
  await assert.rejects((runtime as any).admitModel({ baseUrl: "https://offline.invalid", id: "model" }, false), /Configured local scheduling model is unavailable/);
});
