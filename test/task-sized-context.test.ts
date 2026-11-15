import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Subagents } from "../src/subagents.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { continuationProvenance } from "../src/continuation-provenance.js";
import { personaSections } from "../src/persona.js";

const originalPath = (text: string) => /Complete original at (.*?); sha256=/.exec(text)![1]!;

test("actual SDK requests: Main and children receive excerpts, children skip historical memory and Main boilerplate, tools keep exact originals", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "task-sized-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previousHome = process.env.HOME, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  t.after(() => { for (const [key, value] of Object.entries({ HOME: previousHome, PI_CODING_AGENT_DIR: previousAgent })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  const requests: any[] = [];
  const source = "source header\n" + "large read evidence\n".repeat(1500) + "ERROR: preserve exact failure\n";
  const file = path.join(home, "evidence.txt"); await writeFile(file, source);
  models.registerProvider("bounded-fixture", {
    api: "openai-completions", baseUrl: "https://offline.invalid", apiKey: "offline",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context) => {
      requests.push(structuredClone(context));
      const toolResult = [...context.messages].reverse().find((m: any) => m.role === "toolResult");
      const stream = createAssistantMessageEventStream();
      const message: any = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: toolResult ? [{ type: "text", text: "Read completed; source reports an error, not a verified successful effect. Details retained." }]
          : [{ type: "toolCall", id: "read-evidence", name: "read", arguments: { path: file } }],
        stopReason: toolResult ? "stop" : "toolUse", timestamp: Date.now(),
        usage: { input: 100, output: 20, totalTokens: 120, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(); });
      return stream;
    },
  });
  let recalls = 0;
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), skillPaths: [], model: "bounded-fixture/model", tools: ["read"],
    personaSections: async (_cwd, worker) => personaSections({ soul: "Exact operator constraint: do not publish.", voice: "Do not impersonate the operator.", overlays: [{ name: "MEMORY.md", text: "OLD-MEMORY ".repeat(1000) }] }, { worker }),
    recallStep: async () => { recalls++; return "recalled history"; }, approvals: { mode: "off", tools: [] },
  });
  (runtime as any).modelRuntime = async () => models;
  for (const key of ["main", "dispatch:execution:claim", "subagent:task"]) {
    const wrapped: any = await runtime.open(key);
    const start = requests.length, beforeRecall = recalls;
    try {
      assert.match(await wrapped.prompt("Read the evidence and return the finding, not a dump."), /source reports an error/);
      assert.equal(requests.length - start, 2, "one tool request plus final response; no summarization model request");
      const sent = JSON.stringify(requests[start]);
      assert.match(sent, /do not publish/);
      assert.doesNotMatch(sent, /OLD-MEMORY/, 'Main and workers reference historical overlays instead of injecting the full file');
      assert.match(sent, /Persona\/history index/);
      if (key === "main") assert(recalls > beforeRecall, 'Main retains relevant working-memory recall');
      if (key !== "main") {
        assert.doesNotMatch(sent, /OLD-MEMORY|recalled history|# Agent foundation/);
        assert.match(sent, /Do not impersonate the operator/);
        assert.equal(recalls, beforeRecall);
        assert.match(sent, /several related steps and tool calls/);
        assert.match(sent, /Persona\/history index/);
      }
      const result: any = requests[start + 1].messages.find((m: any) => m.role === "toolResult");
      assert.equal(result.isError, false, "read succeeded; source error is not a fabricated tool failure");
      const excerpt = result.content.map((c: any) => c.text ?? "").join("\n");
      assert(excerpt.length < 4000); assert.match(excerpt, /ERROR: preserve exact failure/);
      const retained = await readFile(originalPath(excerpt), "utf8"); assert.equal(retained, source);
      const detail = await wrapped.session.getToolDefinition("read").execute("detail", { path: originalPath(excerpt), offset: 1, limit: 1 });
      assert.match(detail.content[0].text, /source header/);
    } finally { await wrapped.dispose(); }
  }
  const largeReport = "Findings\n" + "worker report\n".repeat(3000) + "uncertain remote commit\nSTEP-STATUS: blocked: reconcile";
  const report = await runtime.compactResult("dispatch:execution:claim", largeReport);
  assert(report.length < 4000); assert.match(report, /STEP-STATUS: blocked/);
  assert.equal(await readFile(originalPath(report), "utf8"), largeReport);
});

test("parent channels compact long results without another worker or blocking on optimization failure", async () => {
  const runtime = new FakeRuntime();
  let count = 0;
  (runtime as any).compactResult = async (_key: string, _text: string) => { count++; return "summary; exact details retained in run artifact"; };
  const harness = new Harness({ runtime, tickMs: 60000 }); harness.onStateChange = async () => {};
  const subagents = new Subagents(harness, async () => {});
  const handover = { task: "inspect", context: "relevant source", constraints: "read-only", expectedResult: "summary", acceptance: "evidence", model: "fixture/model", thinking: "off" };
  const id = "child";
  subagents.restore([{ id, parent: "main", sessionKey: "subagent:child", handover, state: "running", expiresAt: Date.now() + 60000 }]);
  try {
    await subagents.channel.send({ channel: "subagents", target: id }, "long report ".repeat(1000));
    assert.equal(subagents.get("main", id).result, "summary; exact details retained in run artifact");
    assert.equal(subagents.get("main", id).state, "completed"); assert.equal(count, 1);
    (runtime as any).compactResult = async () => { throw Error("optional store unavailable"); };
    subagents.restore([{ id: "second", parent: "main", sessionKey: "subagent:second", handover, state: "running", expiresAt: Date.now() + 60000 }]);
    await subagents.channel.send({ channel: "subagents", target: "second" }, "completed original result");
    assert.equal(subagents.get("main", "second").result, "completed original result");
    assert.equal(subagents.get("main", "second").state, "completed");
    subagents.restore([{ id: "oversized", parent: "main", sessionKey: "subagent:oversized", handover, state: "running", expiresAt: Date.now() + 60000 }]);
    await subagents.channel.send({ channel: "subagents", target: "oversized" }, "detail ".repeat(15000) + "\nINCOMPLETE: uncertain effect");
    const bounded = subagents.get("main", "oversized");
    assert(bounded.result!.length < 64000); assert.match(bounded.result!, /full native session subagent:oversized/); assert.match(bounded.result!, /INCOMPLETE: uncertain effect/);
  } finally { await subagents.channel.stop(); await harness.stop(0); }
});

test("host provenance does not repeat an identical mandate, distinct original is still preserved", () => {
  const input: any = { source: "host", sessionKey: "main", text: "worker result", completionAnchor: { id: "op", task: "exact mandate" } };
  assert.match(continuationProvenance(input), /exact mandate/);
  assert.doesNotMatch(continuationProvenance(input, true), /exact mandate/);
  assert.match(continuationProvenance(input, true), /provided once/);
});
