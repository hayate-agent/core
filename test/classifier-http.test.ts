import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { classifyHttp, type ClassifierReceipt } from "../src/classifier-http.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { ExecutionStore } from "../src/execution.js";

async function runtime(api: string) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "offline-fixture" }));
  const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const delegates = {
    "openai-responses": () => import("@earendil-works/pi-ai/api/openai-responses"),
    "openai-completions": () => import("@earendil-works/pi-ai/api/openai-completions"),
    "anthropic-messages": () => import("@earendil-works/pi-ai/api/anthropic-messages"),
  };
  const delegate = await delegates[api as keyof typeof delegates]();
  const model = runtime.getModels("openai")[0]!;
  runtime.registerProvider("openai", { api, models: [
    { ...model, id: "first", api, baseUrl: "https://offline.invalid" },
    { ...model, id: "default", api, baseUrl: "https://offline.invalid" },
  ], streamSimple: (model, context, options) => {
    assert.equal(options?.apiKey, "offline-fixture");
    assert.equal(options?.maxRetries, 0);
    assert.equal(context.tools, undefined);
    assert.equal(context.messages.filter(m => m.role === "user").length, 1);
    return delegate.streamSimple(model as never, context, options);
  } });
  assert.equal(runtime.getPhysicalModel("openai", "first")!.api, api);
  assert.ok(getSupportedThinkingLevels(runtime.getPhysicalModel("openai", "first")!).includes("off"));
  assert.ok(await runtime.getAuth(runtime.getPhysicalModel("openai", "first")!));
  return runtime;
}
const requested = { model: "openai/first", thinking: "off" };
const defaults = { model: "openai/default", thinking: "off" };
function rejection(status = 429, body = "untrusted 429") {
  return new Response(JSON.stringify({ error: { message: body, type: "rate_limit_error" } }), { status, headers: { "content-type": "application/json" } });
}
function success(api: string) {
  const text = '{"complexity":"simple"}';
  const events = api === "openai-completions" ? [
    { id: "x", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ] : api === "anthropic-messages" ? [
    { type: "message_start", message: { id: "x", role: "assistant", content: [], model: "default", usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ] : [
    { type: "response.created", response: { id: "x", model: "default" } },
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] } },
    { type: "response.completed", response: { id: "x", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ];
  return new Response(events.map(e => `event: ${"type" in e ? e.type : "message"}\ndata: ${JSON.stringify(e)}\n\n`).join("") + (api === "openai-completions" ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
}
for (const api of ["anthropic-messages", "openai-responses", "openai-completions"]) {
  test(`${api}: real SDK, first 429 -> different default, durable before both sends`, async () => {
    const rt = await runtime(api);
    const receipts: ClassifierReceipt[] = [];
    let sends = 0;
    const actual: string[] = [];
    const result = await classifyHttp(rt, { task: "work", requested, defaults, signal: new AbortController().signal,
      authorize() {}, persist: async r => { receipts.push(r); }, observe: r => { actual.push(r.model!); },
    }, async () => {
      assert.equal(receipts.at(-1)?.phase, sends === 0 ? "initial" : "fallback");
      return ++sends === 1 ? rejection() : success(api);
    });
    assert.equal(result, "simple");
    assert.equal(sends, 2);
    assert.deepEqual(actual, [requested.model, defaults.model]);
    assert.deepEqual(receipts.map(r => r.phase), ["initial", "fallback", "observed"]);
  });
}
test("same default, unsupported/default preflight, 500 body, fallback rejection: never a third send", async () => {
  const rt = await runtime("openai-completions");
  for (const [fallback, status, expected] of [[requested, 429, 1], [{ model: "missing/model" }, 429, 1], [defaults, 500, 1], [defaults, 429, 2]] as const) {
    let sends = 0;
    await classifyHttp(rt, { task: "work", requested, defaults: fallback, signal: new AbortController().signal,
      authorize() {}, persist: async () => {},
    }, async () => { sends++; return rejection(status, "429"); }).catch(() => undefined);
    assert.equal(sends, expected);
  }
});
test("initial/fallback save failures prevent their send; abort/deadline prevent fallback", async () => {
  const rt = await runtime("openai-completions");
  for (const phase of ["initial", "fallback"]) {
    let sends = 0;
    await assert.rejects(classifyHttp(rt, { task: "x", requested, defaults, signal: new AbortController().signal,
      authorize() {}, persist: async r => { if (r.phase === phase) throw Error("disk"); },
    }, async () => { sends++; return rejection(); }), /disk/);
    assert.equal(sends, phase === "initial" ? 0 : 1);
  }
  const controller = new AbortController();
  let sends = 0;
  await assert.rejects(classifyHttp(rt, { task: "x", requested, defaults, signal: controller.signal,
    authorize() {}, persist: async () => {},
  }, async () => { sends++; controller.abort(); return rejection(); }));
  assert.equal(sends, 1);
  await assert.rejects(classifyHttp(rt, { task: "x", requested, defaults, signal: AbortSignal.abort(), authorize() {}, persist: async () => {} }, async () => { throw Error("must not send"); }));
});
test("partial stream and unobserved rejection never fallback", async () => {
  const rt = await runtime("openai-completions");
  for (const partial of [false, true]) {
    let sends = 0;
    await classifyHttp(rt, { task: "x", requested, defaults, signal: new AbortController().signal, authorize() {}, persist: async () => {} }, async () => {
      sends++;
      return new Response(new ReadableStream({ start(c) {
        if (partial) c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'));
        c.error(Error("disconnect"));
      } }), { status: partial ? 200 : 429 });
    }).catch(() => {});
    assert.equal(sends, 1);
  }
});
test("real ExecutionStore reload retains unknown markers across recovery, no duplicate initial", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "classifier-receipt-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  const submitted = await store.submit("p", "r", "x", "direct");
  const task = await store.claim(submitted.id);
  await store.classifierAssessment(task.id, task.token!, { phase: "initial", actual: requested });
  const reload = new ExecutionStore(file); await reload.load();
  assert.equal(reload.list()[0]?.classifierReceipt?.phase, "initial");
  await reload.recover(new Map([["direct", { version: 1, replaySafe: false }]]));
  assert.equal(reload.list()[0]?.status, "blocked");
  await reload.resolve("p", task.id, "operator", "continue", "inspect unknown receipt, no replay");
  const next = await reload.claim(task.id);
  await assert.rejects(reload.classifierAssessment(task.id, next.token!, { phase: "initial", actual: requested }), /cannot be replayed/);
  await assert.rejects(reload.classifierAssessment(task.id, task.token!, { phase: "fallback", actual: defaults }), /Stale/);
});
test("real store failed durable write fences send; fallback and result receipts survive reload", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "classifier-durable-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rt = await runtime("openai-completions");
  for (const phase of ["initial", "fallback"] as const) {
    const file = path.join(home, phase + ".json");
    const store = new ExecutionStore(file); await store.load();
    const task = await store.claim((await store.submit("p", phase, "x", "direct")).id);
    let sends = 0;
    await assert.rejects(classifyHttp(rt, { task: "x", requested, defaults, signal: new AbortController().signal, authorize() {},
      persist: async receipt => {
        if (receipt.phase === phase) { await rm(file, { force: true }); await mkdir(file); }
        await store.classifierAssessment(task.id, task.token!, receipt);
      },
    }, async () => { sends++; return rejection(); }));
    assert.equal(sends, phase === "initial" ? 0 : 1);
    assert.equal(store.list()[0]?.classifierReceipt?.phase, phase === "initial" ? undefined : "initial");
  }
  for (const phase of ["fallback", "observed"] as const) {
    const file = path.join(home, phase + "-crash.json");
    const store = new ExecutionStore(file); await store.load();
    const task = await store.claim((await store.submit("p", phase, "x", "direct")).id);
    await store.classifierAssessment(task.id, task.token!, { phase: "initial", actual: requested });
    await store.classifierAssessment(task.id, task.token!, { phase: "fallback", actual: defaults });
    if (phase === "observed") await store.classifierAssessment(task.id, task.token!, { phase, actual: defaults, complexity: "simple" });
    const reload = new ExecutionStore(file); await reload.load();
    await reload.recover(new Map([["direct", { version: 1, replaySafe: false }]]));
    assert.equal(reload.list()[0]?.classifierReceipt?.phase, phase);
    assert.equal(reload.list()[0]?.status, phase === "fallback" ? "blocked" : "ready");
  }
});
test("parallel assessments keep transport/receipt isolated; no shared provider mutation", async () => {
  const rt = await runtime("openai-completions");
  const provider = rt.getProvider("openai");
  await Promise.all([1, 2].map(async task => {
    const phases: string[] = [];
    let sends = 0;
    const result = await classifyHttp(rt, { task: String(task), requested, defaults, signal: new AbortController().signal,
      authorize() {}, persist: async r => { phases.push(r.phase); },
    }, async () => ++sends === 1 ? rejection() : success("openai-completions"));
    assert.equal(result, "simple");
    assert.deepEqual(phases, ["initial", "fallback", "observed"]);
  }));
  assert.equal(rt.getProvider("openai"), provider);
});
