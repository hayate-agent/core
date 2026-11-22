import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";
import { capabilityContext } from "../src/capability-context.js";
import { personaSections } from "../src/persona.js";
import { DISPATCH_TOOL_GUIDANCE } from "../src/context-contract.js";
import { DISPATCH_PLAN_SYSTEM_PROMPT } from "../src/planner-http.js";

const { convertMessages } = await import(new URL("api/openai-completions.js", import.meta.resolve("@earendil-works/pi-ai")).href);

test("actual SDK separates shared policy, dispatch tool protocol, worker and tool-free planner", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-prompt-"));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(home, { recursive: true, force: true });
  });
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  await models.setRuntimeApiKey("separation-fixture", "fixture");
  const requests: any[] = [];
  models.registerProvider("separation-fixture", { api: "openai-completions", baseUrl: "https://offline.invalid", models: [{
    id: "model", name: "Offline fixture", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 2048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple: (model, context) => {
    requests.push(structuredClone(context));
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: [{ type: "text", text: "Observed fixture only." }], stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); }); return stream;
  } });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), skillPaths: [], model: "separation-fixture/model",
    contextBudgets: () => ({ localModels: ["separation-fixture/model"] }), approvals: { mode: "off", tools: [] },
    personaSections: async (_cwd, worker) => personaSections({ soul: "Exact operator scope remains binding." }, { worker }),
    pluginTools: () => [{ name: "plugin_dispatch", description: "Submit using the validated schema.", parameters: { type: "object", properties: {} }, execute: async () => { throw Error("No effects allowed in fixture"); } }] });
  (runtime as any).modelRuntime = async () => models;
  const facts = (sessionKey: string) => capabilityContext({ revision: 1, sessionKey, selectedTools: undefined,
    registeredTools: ["plugin_dispatch"], dispatcherEnabled: false, dispatcherReady: false, reviewInstructions: "" });
  for (const key of ["main", "dispatch:fixture:claim", "subagent:fixture"]) {
    const wrapped: any = await runtime.open(key);
    try {
      await wrapped.prompt("Inspect only.", { instructions: facts(key) });
      const first = requests.at(-1);
      const text = JSON.stringify(convertMessages({ id: "model", provider: "separation-fixture", api: "openai-completions", input: ["text"] } as any, first,
        { supportsMidConvoSystemMessages: false, supportsDeveloperRole: false }));
      assert.doesNotMatch(text, /Dispatcher work is asynchronous|Submit with action=submit|Blocked dispatcher resume|resume-paused/);
      assert.match(text, /Exact operator scope remains binding/);
      if (key.startsWith("dispatch:") || key.startsWith("subagent:")) {
        assert.match(text, /Hayate task worker/);
        assert.doesNotMatch(text, /# Agent foundation|Main may use its available tools directly/);
      } else assert.match(text, /# Agent foundation/);
      if (key.startsWith("dispatch:") || key.startsWith("subagent:")) {
        assert.equal(wrapped.session.getAllTools().some((tool: any) => tool.name === "plugin_dispatch"), false,
          "neither child role can discover parent-only dispatcher operation");
      } else {
        await wrapped.session.getToolDefinition("tool_search").execute("discover", { query: "plugin_dispatch", limit: 1 });
        await wrapped.prompt("Inspect the discovered schema only.", { instructions: facts(key) });
        const tools = requests.at(-1).messages.flatMap((message: any) => message.toolsAdded ?? []);
        const dispatch = tools.find((tool: any) => tool.name === "plugin_dispatch");
        assert.ok(dispatch?.description.includes(DISPATCH_TOOL_GUIDANCE), "operation guidance follows discovery of its tool");
        assert.doesNotMatch(wrapped.session.systemPrompt, /Dispatcher work is asynchronous/);
      }
    } finally { await wrapped.dispose(); }
  }
  const planner: any = await runtime.open("plan:fixture", { ephemeral: true, assessmentPurpose: "dispatch-plan" });
  try {
    await planner.prompt("Plan the bounded fixture; no execution.");
    assert.ok(planner.session.systemPrompt.startsWith(DISPATCH_PLAN_SYSTEM_PROMPT));
    assert.equal(planner.session.systemPrompt.replace(DISPATCH_PLAN_SYSTEM_PROMPT, "").trim(), `<cwd>\n${home}\n</cwd>`, "SDK planner adds only cwd, not Main policy");
    assert.deepEqual(planner.session.getActiveToolNames(), []);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /# Agent foundation|# Tool results|Dispatcher work is asynchronous/);
  } finally { await planner.dispose(); }
});
