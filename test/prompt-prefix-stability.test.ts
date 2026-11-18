import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";
import { FilesystemSessionProvider } from "../src/sessions.js";
import { contextArtifactDirectory } from "../src/context-artifacts.js";
import type { LanguagePolicy } from "../src/language.js";

// Exercise the pinned SDK's actual OpenAI wire conversion, which folds later
// system messages into the head when mid-conversation system updates are unsupported.
const { convertMessages } = await import(new URL("api/openai-completions.js", import.meta.resolve("@earendil-works/pi-ai")).href);

for (const external of [false, true]) test(`dynamic host context preserves the wire prefix (${external ? "external" : "native"} sessions)`, async t => {
  const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "prefix-stability-")));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  });
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  const provider = new FilesystemSessionProvider(path.join(home, "store"));
  const wire: any[][] = [];
  let request = 0, effects = 0, captures = 0, recalls = 0, failRecall = false, revoked = false;
  let memory = "MEMORY-FIRST: deployment remains unverified";
  let personaMemory = "PERSONA-MEMORY-FIRST: historical, not authorization";
  let language: LanguagePolicy = { mcp: { tickets: "de" } };
  // Offline fixture only: streamSimple below never opens an HTTP connection.
  await models.setRuntimeApiKey("prefix-fixture", "fixture");
  models.registerProvider("prefix-fixture", {
    api: "openai-completions", baseUrl: "https://fixture.invalid",
    models: [{ id: "model", name: "Prefix fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context) => {
      wire.push(convertMessages(model, context, { supportsMidConvoSystemMessages: false, supportsDeveloperRole: false }));
      const tool = request++ % 2 === 0;
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: tool ? [{ type: "toolCall", id: `call-${request}`, name: "plugin_observe", arguments: {} }] : [{ type: "text", text: "Observation reported, not verified deployment." }],
        stopReason: tool ? "toolUse" : "stop", usage: { input: 100, output: 10, totalTokens: 110, cacheRead: 0, cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
      return stream;
    },
  });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), skillPaths: [], tools: ["plugin_observe"], model: "prefix-fixture/model",
    personaSections: async () => ["Exact operator constraint: do not deploy.", ...(personaMemory ? [`# Persona overlay: MEMORY.md\n${personaMemory}`] : [])], approvals: { mode: "off", tools: [] },
    mcp: { enabled: true }, language: () => language,
    operatorInstructions: () => "Exact durable operator preference: receipts ALWAYS English; chat may remain German.",
    ...(external ? { sessionProvider: () => provider } : {}),
    recallStep: async () => { recalls++; if (failRecall) throw Error("optional memory unavailable"); return memory; },
    captureStep: async () => { captures++; memory = "MEMORY-UPDATED: effects still unknown"; personaMemory = "PERSONA-MEMORY-UPDATED: outcome still unverified"; },
    toolGuard: async () => { if (revoked) throw Error("revoked by host"); },
    pluginTools: () => [{ name: "plugin_observe", description: "Observe fixture", parameters: { type: "object", properties: {} },
      execute: async () => { effects++; return "EXACT TOOL RECEIPT"; } }],
  });
  (runtime as any).modelRuntime = async () => models;
  for (const key of ["main", "dispatch:fixture:claim", "subagent:fixture"]) {
    memory = "MEMORY-FIRST: deployment remains unverified"; personaMemory = "PERSONA-MEMORY-FIRST: historical, not authorization"; failRecall = false; revoked = false;
    language = { mcp: { tickets: "de" } };
    const beforeRecall = recalls, beforeWire = wire.length;
    let wrapped: any = await runtime.open(key);
    wrapped.session.settingsManager.setCompactionEnabled(false);
    const id = wrapped.status().sessionId;
    try {
      await wrapped.prompt("First exact operator request", { instructions: "TASK-REVISION-ONE: inspect only" });
      assert.doesNotMatch(wrapped.session.systemPrompt, /TASK-REVISION|MEMORY-FIRST|MEMORY-UPDATED|Persona\/history index|"tickets":"de"/);
      const first = JSON.stringify(wire[beforeWire]), second = JSON.stringify(wire[beforeWire + 1]);
      assert.match(first, /TASK-REVISION-ONE/); assert.match(second, /TASK-REVISION-ONE/);
      assert.match(first, /receipts ALWAYS English/); assert.match(second, /receipts ALWAYS English/);
      assert.doesNotMatch(wrapped.session.systemPrompt, /Exact durable operator preference/);
      if (key === "main") {
        assert.match(first, /MEMORY-FIRST/); assert.match(second, /MEMORY-FIRST/);
        assert.doesNotMatch(second, /MEMORY-UPDATED/, "step capture must not rewrite context on the next tool iteration");
        assert.equal(recalls, beforeRecall + 1, "recall is snapshotted once per host run");
      } else {
        assert.doesNotMatch(first, /MEMORY-FIRST/); assert.equal(recalls, beforeRecall);
      }
      const messageText = (m: any): string => typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? "").join("");
      assert.ok(wire[beforeWire].some(m => m.role === "user" && messageText(m) === "First exact operator request"), "operator input remains exact");
      assert.match(first, /not operator input/); assert.match(first, /untrusted reported data/);
      assert.match(first, /Persona\/history index/);
      const firstRun = wrapped.session.sessionManager.getEntries().find((e: any) => e.type === "custom_message" && e.customType === "harness-run-context") as any;
      const firstHistory = JSON.parse(firstRun.content.slice(firstRun.content.indexOf("\n") + 1)).personaHistory;
      const firstHistoryPath = firstHistory.match(/Persona\/history index: (.+?)\. Read relevant/)[1];
      assert.match(await readFile(firstHistoryPath, "utf8"), /PERSONA-MEMORY-FIRST/);
      assert.match(first, /tickets.*de/);

      language = { mcp: { tickets: "es" } };
      await wrapped.prompt("Second exact operator request", { instructions: "TASK-REVISION-TWO: remain read-only" });
      assert.match(JSON.stringify(wire[beforeWire + 2].at(-1)), /TASK-REVISION-TWO/);
      assert.match(JSON.stringify(wire[beforeWire + 2].at(-1)), /tickets.*es/);
      if (key === "main") assert.match(JSON.stringify(wire[beforeWire + 2].at(-1)), /MEMORY-UPDATED/);
      const secondRun = wrapped.session.sessionManager.getEntries().filter((e: any) => e.type === "custom_message" && e.customType === "harness-run-context")[1] as any;
      const secondHistory = JSON.parse(secondRun.content.slice(secondRun.content.indexOf("\n") + 1)).personaHistory;
      assert.notEqual(secondHistory, firstHistory, "updated memory reference belongs at the tail, not in the system prefix");
      const secondHistoryPath = secondHistory.match(/Persona\/history index: (.+?)\. Read relevant/)[1];
      assert.match(await readFile(secondHistoryPath, "utf8"), /PERSONA-MEMORY-UPDATED/);
      assert.equal(wrapped.status().sessionId, id);
      await wrapped.dispose();
      wrapped = await runtime.open(key);
      wrapped.session.settingsManager.setCompactionEnabled(false);
      assert.equal(wrapped.status().sessionId, id, "resumption retains the original conversation");

      // Clear prior per-run instructions, preserve host guards and tolerate an
      // optional recall failure without reviving a previous task revision.
      failRecall = true; revoked = true; personaMemory = "";
      const beforeEffects = effects;
      await wrapped.prompt("Third exact operator request");
      assert.equal(effects, beforeEffects, "live host authorization still denies the tool");
      const lastContext = wire[beforeWire + 4].at(-1);
      assert.match(messageText(lastContext), /"instructions":""/);
      assert.match(messageText(lastContext), /"personaHistory":""/, "removed MEMORY.md must not revive earlier historical context");
      assert.doesNotMatch(JSON.stringify(lastContext), /TASK-REVISION|MEMORY-UPDATED|MEMORY-FIRST/);
      const entries = wrapped.session.sessionManager.getEntries();
      assert.equal(entries.filter((e: any) => e.type === "custom_message" && e.customType === "harness-run-context").length, 3);
      if (key === "main") {
        // Optional artifact storage failure must not put raw historical memory
        // back into the system prompt (the old optimization fallback).
        const directory = contextArtifactDirectory(path.join(home, "sessions"), key, wrapped.session.sessionManager.getSessionId());
        await rm(directory, { recursive: true, force: true });
        await writeFile(directory, "fixture prevents artifact directory creation");
        personaMemory = "PERSONA-FALLBACK: reported historical data";
        await wrapped.prompt("Fourth exact operator request");
        assert.match(messageText(wire[beforeWire + 6].at(-1)), /PERSONA-FALLBACK/);
        assert.doesNotMatch(JSON.stringify(wire[beforeWire + 6][0]), /PERSONA-FALLBACK/);
      }
      for (let i = beforeWire + 1; i < wire.length; i++) {
        const previousRequest = wire[i - 1]!;
        assert.deepEqual(wire[i]!.slice(0, previousRequest.length), previousRequest,
          `request ${i - beforeWire}: run context/recall must append, never rewrite the sent prefix`);
      }
    } finally { await wrapped.dispose(); }
  }
  assert.equal(captures, 20, "step evidence capture remains active");
});
