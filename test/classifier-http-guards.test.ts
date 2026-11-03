import test from "node:test";
import assert from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { classifyHttp, type ClassifierReceipt } from "../src/classifier-http.js";

const requested = { model: "openai/first", thinking: "off" };
const defaults = { model: "openai/default", thinking: "off" };
async function fixture(api = "openai-completions", retry = false) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "offline-fixture" }));
  const rt = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const model = rt.getModels("openai")[0]!;
  rt.registerProvider("openai", { api, models: ["first", "default"].map(id => ({ ...model, id, api, baseUrl: "https://offline.invalid" })),
    streamSimple: (model, context, options) => streamSimple(model as never, context, { ...options, maxRetries: retry ? 1 : 0 }),
  });
  return rt;
}
const rejected = () => new Response('{"error":{"message":"rate limit"}}', { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } });
test("real SDK accidentally enabled retry: second attempted fetch is fenced, no default", async () => {
  const rt = await fixture("openai-completions", true);
  let sends = 0;
  const phases: string[] = [];
  await assert.rejects(classifyHttp(rt, { task: "x", requested, defaults, signal: new AbortController().signal,
    authorize() {}, persist: async r => { phases.push(r.phase); },
  }, async () => { sends++; return rejected(); }), /unknown/);
  assert.equal(sends, 1);
  assert.deepEqual(phases, ["initial"]);
});
test("unknown API and virtual model never enter a send or persist receipt", async () => {
  const rt = await fixture("openai-codex-responses");
  const unexpected = async () => { throw Error("must not happen"); };
  assert.equal(await classifyHttp(rt, { task: "x", requested, defaults, signal: new AbortController().signal,
    authorize() {}, persist: unexpected,
  }, unexpected), undefined);
  rt.registerVirtualModel({ provider: "openai", id: "virtual", name: "virtual", contextWindow: 1000, maxTokens: 100,
    route: () => { throw Error("virtual routing forbidden"); },
  });
  assert.equal(await classifyHttp(rt, { task: "x", requested: { model: "openai/virtual" }, defaults,
    signal: new AbortController().signal, authorize() {}, persist: unexpected,
  }, unexpected), undefined);
});
test("deadline during rejection observation and ownership loss after durable marker prevent fallback", async () => {
  const rt = await fixture();
  let sends = 0;
  let consumed: ClassifierReceipt | undefined;
  await assert.rejects(classifyHttp(rt, { task: "x", requested, defaults, signal: AbortSignal.timeout(10),
    authorize() {}, persist: async r => { consumed = r; },
  }, async () => {
    sends++;
    await new Promise(resolve => setTimeout(resolve, 30));
    return rejected();
  }));
  assert.equal(sends, 1);
  assert.equal(consumed?.phase, "initial");
  let owner = true;
  sends = 0;
  await assert.rejects(classifyHttp(rt, { task: "x", requested, defaults, signal: new AbortController().signal,
    authorize() { if (!owner) throw Error("stale claim"); },
    persist: async r => { if (r.phase === "fallback") owner = false; },
  }, async () => { sends++; return rejected(); }), /stale claim/);
  assert.equal(sends, 1);
});
