import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { reviewHttp } from "../src/reviewer-http.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git } from "../src/changeset.js";
import { ReviewService } from "../src/builtin-plugins/review.js";
import { reviewConfig } from "../src/review-config.js";
import { ReviewWorkers } from "../src/review-execution.js";
import { ReviewSubagents } from "../src/review-subagents.js";
import { handoverWorktreeReview } from "../src/review-worktree.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime } from "./fakes.js";
import type { ReviewHttpReceipt } from "../src/builtin-plugins/review-executor.js";

async function fixture(api: string) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai", async () => ({ type: "api_key", key: "offline-fixture" }));
  const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false });
  const delegate = api === "anthropic-messages" ? await import("@earendil-works/pi-ai/api/anthropic-messages")
    : api === "openai-responses" ? await import("@earendil-works/pi-ai/api/openai-responses")
      : await import("@earendil-works/pi-ai/api/openai-completions");
  const model = runtime.getModels("openai")[0]!;
  runtime.registerProvider("openai", { api, models: ["first", "default"].map(id => ({ ...model, id, api, baseUrl: "https://offline.invalid" })),
    streamSimple(model, context, options) {
      assert.equal(options?.apiKey, "offline-fixture");
      assert.equal(options?.maxRetries, 0);
      assert.equal(context.tools, undefined);
      return delegate.streamSimple(model as never, context, options);
    } });
  return runtime;
}
function success(api: string) {
  const text = '{"findings":[]}';
  const events = api === "openai-completions" ? [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
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
const requested = { model: "openai/first", thinking: "off" };
const defaults = { model: "openai/default", thinking: "off" };
const prompt = "review candidate";
const digest = createHash("sha256").update(prompt).digest("hex");
for (const api of ["anthropic-messages", "openai-responses", "openai-completions"]) {
  test(`${api}: dedicated JSON result, normal auth and two persist-before-send boundaries`, async () => {
    const rt = await fixture(api);
    const receipts: ReviewHttpReceipt[] = [];
    let sends = 0;
    const result = await reviewHttp(rt, prompt, { id: "round", promptDigest: digest, requested, defaults,
      closed: () => receipts.at(-1), consumed: () => receipts.length > 0, persist: async r => { receipts.push(r); },
    }, "child", new AbortController().signal, async () => {
      assert.equal(receipts.at(-1)?.phase, sends ? "fallback" : "initial");
      return ++sends === 1 ? new Response("reject", { status: 429 }) : success(api);
    });
    assert.equal(result, '{"findings":[]}');
    assert.equal(sends, 2);
    assert.deepEqual(receipts.map(r => r.phase), ["initial", "fallback", "observed"]);
    assert.equal(receipts.at(-1)?.actual.model, defaults.model);
    assert.equal(receipts.at(-1)?.executionId, "child");
  });
}
test("same/unavailable default, double429, misleading500 and failed saves never grant third send", async () => {
  const rt = await fixture("openai-completions");
  for (const [fallback, status, fail, expected] of [
    [requested, 429, "", 1], [{ model: "missing/model" }, 429, "", 1],
    [defaults, 429, "", 2], [defaults, 500, "", 1],
    [defaults, 429, "initial", 0], [defaults, 429, "fallback", 1],
    [defaults, 429, "observed", 2],
  ] as const) {
    let sends = 0;
    await assert.rejects(reviewHttp(rt, prompt, { id: "round", promptDigest: digest, requested, defaults: fallback,
      closed: () => undefined, consumed: () => false, persist: async r => { if (r.phase === fail) throw Error("disk"); },
    }, "child", new AbortController().signal, async () => { sends++; return new Response("429", { status }); }));
    assert.equal(sends, expected);
  }
});

for (const phase of ["initial", "fallback"] as const) {
  test(`deadline abort reaches SDK transport during ${phase}`, async () => {
    const rt = await fixture("openai-completions");
    const controller = new AbortController();
    let sends = 0;
    const receipts: ReviewHttpReceipt[] = [];
    await assert.rejects(reviewHttp(rt, prompt, { id: "round", promptDigest: digest, requested, defaults,
      consumed: () => false, closed: () => receipts.at(-1), persist: async r => { receipts.push(r); },
    }, "child", controller.signal, async (_url, init) => {
      sends++;
      assert.equal(init?.signal, controller.signal);
      if (phase === "fallback" && sends === 1) return new Response("reject", { status: 429 });
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(Error("deadline")), { once: true });
        controller.abort();
      });
    }));
    assert.equal(sends, phase === "initial" ? 1 : 2);
    assert.equal(receipts.at(-1)?.phase, phase);
  });
}

for (const route of ["dispatcher", "subagent", "worktree"] as const) {
  test(`real ledger + isolated ${route} + SDK fakefetch persists fallback and finalizes`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "review-sdk-route-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = path.join(home, "repo");
    await git(home, ["init", root]); await git(root, ["config", "user.name", "Fixture"]);
    await git(root, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "a.ts"), "before"); await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "baseline"]); await writeFile(path.join(root, "a.ts"), "after");
    const rt = await fixture("openai-completions"); let sends = 0;
    const runtime = new FakeRuntime(() => { throw Error("must use HTTP not session prompt"); });
    const open = runtime.open.bind(runtime);
    runtime.open = async (key, options) => Object.assign(await open(key, options), { seedHandover: async () => {} });
    Object.assign(runtime, { reviewCodeHttp: (text: string, a: Parameters<typeof reviewHttp>[2], id: string, signal: AbortSignal) =>
      reviewHttp(rt, text, a, id, signal, async () => ++sends === 1 ? new Response("reject", { status: 429 }) : success("openai-completions")),
      forReviewWorktree: (cwd: string) => { assert.notEqual(cwd, root); return runtime; },
    });
    const workers = new ReviewWorkers(runtime, new ExecutionStore(path.join(home, "executions.json")), 1);
    const subagents = new ReviewSubagents(runtime, path.join(home, "children"));
    t.after(async () => { await workers.stop(); await subagents.stop(); });
    const execution = { dispatcherEnabled: () => route === "dispatcher",
      httpSelection: async () => ({ requested, defaults }),
      dispatcherWorker: (request: Parameters<typeof workers.review>[0]) => workers.review(request),
      subagent: (request: Parameters<typeof workers.review>[0]) => route === "worktree" ? Promise.reject(Error("unavailable before send")) : subagents.review(request),
      handoverWorktree: (request: Parameters<typeof workers.review>[0]) => handoverWorktreeReview(runtime, request),
    };
    const service = new ReviewService(home, reviewConfig({ enabled: true, baseRef: "HEAD" }), async () => { throw Error("no self review"); }, async () => {}, execution);
    const state = await service.run(root, "parent");
    assert.equal(state.status, "passed"); assert.equal(sends, 2);
    assert.equal(state.rounds[0].httpAssessment?.executionValidated, true);
    assert.equal(state.rounds[0].httpAssessment?.receipt?.actual.model, defaults.model);
    await service.run(root, "parent"); assert.equal(sends, 2);
  });
}
