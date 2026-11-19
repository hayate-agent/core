import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";
import { AdaptiveSkills } from "../src/adaptive-skills.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { isBoundedReadResult } from "../src/bounded-read-result.js";
import { pruningPolicy } from "../src/tool-result-pruning.js";
import { pruneToolResults } from "../src/builtin-plugins/tool-result-projector.js";
import { FilesystemSessionProvider } from "../src/sessions.js";
const { convertMessages } = await import(new URL("api/openai-completions.js", import.meta.resolve("@earendil-works/pi-ai")).href);

for (const external of [false, true]) test(`bounded middle-file reads survive actual SDK, all projections and reopen (${external ? "external" : "native"})`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "bounded-sdk-")); t.after(() => rm(home, { recursive: true, force: true }));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const text = Array.from({ length: 200 }, (_, i) => `${i + 1}:` + "range detail ".repeat(18)).join("\n");
  await writeFile(path.join(home, "evidence.txt"), text);
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  const provider = new FilesystemSessionProvider(path.join(home, "store"));
  let previousWire: any[] | undefined, stage = 0, readText = "", requests = 0;
  await models.setRuntimeApiKey("bounded-fixture", "offline");
  models.registerProvider("bounded-fixture", { api: "openai-completions", baseUrl: "https://offline.invalid", models: [{
    id: "model", name: "Bounded read fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple: (model, context) => {
    requests++;
    const wire = convertMessages(model, context, { supportsMidConvoSystemMessages: false, supportsDeveloperRole: false });
    if (previousWire) assert.deepEqual(wire.slice(0, previousWire.length), previousWire, "bounded evidence remains prefix-stable within a host run");
    previousWire = structuredClone(wire);
    const results: any[] = context.messages.filter((m: any) => m.role === "toolResult");
    const range = results.find(m => m.toolName === "read");
    if (stage === 1) assert(range, "retained exact read must be present in every continuation/reopen request");
    if (range) {
      const actual = range.content[0].text;
      assert.match(actual, /153:range detail/, "required middle evidence must not disappear behind a second head/tail excerpt");
      assert.match(actual, /^\[Read range:/);
      assert.doesNotMatch(actual, /omitted|excerpt|duplicate/i);
      assert.equal(actual, readText || actual); readText = actual;
      assert.equal(actual.split("\nHost skill evidence receipt:")[0].split("\n").slice(1).join("\n"), text.split("\n").slice(149, 156).join("\n") + "\n");
      assert.match(actual, /Host skill evidence receipt:/);
      assert(isBoundedReadResult(range), "host skill receipt must not invalidate bounded range protection");
    }
    const next = results.length;
    let call: any;
    if (stage === 0 && next < 3) call = next === 1
      ? { type: "toolCall", id: "range", name: "read", arguments: { path: "evidence.txt", offset: 150, limit: 7 } }
      : { type: "toolCall", id: `fill-${next}`, name: "plugin_fill", arguments: {} };
    const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: call ? [call] : [{ type: "text", text: "Evidence found in exact range." }], stopReason: call ? "toolUse" : "stop",
      usage: { input: 1000, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 1020, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); }); return stream;
  } });
  const adaptiveSkills = new AdaptiveSkills(home, home, new SkillCatalog(path.join(home, "skills-index.json"), () => []));
  const runtime = new PiRuntime({ adaptiveSkills, cwd: home, sessionsDir: path.join(home, "sessions"), model: "bounded-fixture/model", tools: ["read", "plugin_fill"], skillPaths: [],
    pruning: () => pruningPolicy({ proactivePruneTokens: 1, minResultChars: 600, maxResultChars: 256 }), projectToolResults: pruneToolResults,
    ...(external ? { sessionProvider: () => provider } : {}), personaSections: async () => ["Exact operator rule: do not deploy."],
    approvals: { mode: "off", tools: [] }, pluginTools: () => [{ name: "plugin_fill", description: "Synthetic prior evidence", parameters: { type: "object", properties: {} },
      execute: async () => "reported evidence ".repeat(200) }] });
  (runtime as any).modelRuntime = async () => models;
  for (const key of ["main", "dispatch:fixture:claim", "subagent:fixture"]) {
    previousWire = undefined; stage = 0; readText = "";
    let session: any = await runtime.open(key);
    session.session.settingsManager.setCompactionEnabled(false);
    try {
      await session.prompt("Retrieve middle evidence.");
      const native = session.session.sessionManager.getEntries().find((e: any) => e.type === "message" && e.message.toolName === "read");
      assert(native.message.details.hayateReadRange);
      stage = 1;
      // A host-run boundary replaces the runtime snapshot, not tool evidence.
      // The exact range/receipt checks above remain active across both runs.
      previousWire = undefined;
      await session.prompt("Summarize without rereading.");
      await session.dispose(); session = await runtime.open(key);
      session.session.settingsManager.setCompactionEnabled(false);
      previousWire = undefined;
      await session.prompt("Resume using retained exact range.");
      assert(readText);
      const reopenedRead = session.session.messages.find((m: any) => m.role === "toolResult" && m.toolName === "read");
      assert(reopenedRead?.details.hayateReadRange, "native bounded range proof survives reopen projection");
    } finally { await session.dispose(); }
  }
  assert.equal(requests, 18, "no extra model requests or repeated reads");
});
