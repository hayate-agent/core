import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/runtime/pi.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert(condition(), "fixture condition reached");
};

test("actual SDK: physical aliases and HTTP assessments share response-lifetime capacity, human jumps waiting background, other models run", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "local-admission-http-"));
  const seen: string[] = [], pending = new Map<string, ServerResponse>();
  const partial = (res: ServerResponse, content: string, finish: string | null = null) => res.write(`data: ${JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 0, model: "shared",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  })}\n\n`);
  const complete = (label: string) => {
    const res = pending.get(label)!; assert(res); pending.delete(label);
    partial(res, label === "classifier" ? '{"complexity":"simple"}' : label, "stop");
    res.end("data: [DONE]\n\n");
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString(), body = JSON.parse(raw);
    const label = ["bg-first", "bg-waiting", "human", "independent", "classifier", "cancelled", "clone-review"]
      .find(s => JSON.stringify(body.messages).includes(`fixture-${s}`));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (!label) { partial(res, "warm", "stop"); res.end("data: [DONE]\n\n"); return; }
    seen.push(label); pending.set(label, res);
    // Headers + own partial output are not completion and cannot release a permit.
    partial(res, "");
    if (!["bg-first", "human"].includes(label)) complete(label);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const res of pending.values()) res.destroy(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(home, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  for (const provider of ["admission-main", "admission-worker"]) models.registerProvider(provider, {
    api: "openai-completions", baseUrl, apiKey: "offline", models: ["shared", "independent"].map(id => ({
      id, name: id, reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), model: "admission-main/shared", tools: [],
    skillPaths: [], personaSections: async () => [], approvals: { mode: "off", tools: [] },
    contextBudgets: () => ({ localModels: ["admission-main/shared", "admission-worker/shared"] }),
    localModelScheduling: [{ model: "admission-main/shared", concurrency: 1 }],
  });
  (runtime as any).modelRuntime = async () => models;
  const clone = runtime.forReviewWorktree(home); (clone as any).modelRuntime = async () => models;
  const bg1 = await runtime.open("api:fixture-first"), bg2 = await runtime.open("dispatch:fixture:waiting"),
    human = await runtime.open("matrix:fixture-human"), independent = await runtime.open("api:fixture-independent"),
    review = await clone.open("review:fixture-clone", { ephemeral: true });
  t.after(async () => { for (const s of [bg1, bg2, human, independent, review]) { await s.abort(); await s.dispose(); } });
  const first = bg1.prompt("fixture-bg-first"); await until(() => seen.includes("bg-first"));
  const second = bg2.prompt("fixture-bg-waiting", { model: "admission-worker/shared" });
  await tick(); const main = human.prompt("fixture-human");
  const receipts: string[] = [];
  const classified = runtime.classifyComplexityHttp({ task: "fixture-classifier", requested: { model: "admission-worker/shared", thinking: "off" },
    defaults: { model: "admission-worker/shared", thinking: "off" }, signal: new AbortController().signal,
    authorize() {}, persist: async receipt => { receipts.push(receipt.phase); } });
  const cloneResult = review.prompt("fixture-clone-review");
  const independentResult = await independent.prompt("fixture-independent", { model: "admission-main/independent" });
  assert.equal(independentResult, "independent"); assert.deepEqual(seen, ["bg-first", "independent"]);
  complete("bg-first"); assert.equal(await first, "bg-first"); await until(() => seen.includes("human"));
  assert.deepEqual(seen, ["bg-first", "independent", "human"], "queued human outranks earlier worker, classifier and review clone");
  partial(pending.get("human")!, ""); await tick(); assert(!seen.includes("bg-waiting"));
  complete("human"); assert.equal(await main, "human");
  assert.equal(await second, "bg-waiting"); assert.equal(await classified, "simple"); assert.equal(await cloneResult, "clone-review");
  assert.deepEqual(receipts, ["initial", "observed"]);
  assert.deepEqual(seen.slice(0, 3), ["bg-first", "independent", "human"]);
  assert.deepEqual(seen.slice(3).sort(), ["bg-waiting", "classifier", "clone-review"].sort(), "background admission follows actual enqueue order after SDK setup, with no missing or duplicate HTTP call");
});
