import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/runtime/pi.js";

test("queued cancelled or expired work never reaches actual SDK HTTP; acquisition failure cannot consume the following slot", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "admission-fencing-"));
  const sent: string[] = [], server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    sent.push(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "local",
      choices: [{ index: 0, delta: { content: "fixture-ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); });
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  models.registerProvider("fence-admission", { api: "openai-completions", baseUrl, apiKey: "offline", models: [{
    id: "local", name: "fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }] });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), tools: [], model: "fence-admission/local",
    skillPaths: [], personaSections: async () => [], approvals: { mode: "off", tools: [] },
    contextBudgets: () => ({ localModels: ["fence-admission/local"] }),
    localModelScheduling: [{ model: "fence-admission/local", concurrency: 1 }],
  });
  (runtime as any).modelRuntime = async () => models;
  const held = await (runtime as any).admission.acquire(`${baseUrl}\0local`, 1, false);
  const expired = await runtime.open("matrix:expired"), cancelled = await runtime.open("matrix:cancelled");
  t.after(async () => { held(); for (const session of [expired, cancelled]) { await session.abort(); await session.dispose(); } });
  let authorized = true, checks = 0;
  const expiredPrompt = expired.prompt("fixture-expired", { beforeExecution: () => { checks++; if (!authorized) throw Error("fixture mandate expired"); } });
  for (let i = 0; i < 100 && !checks; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert(checks > 0); authorized = false;
  const cancelledPrompt = cancelled.prompt("fixture-cancelled");
  await new Promise(resolve => setTimeout(resolve, 50)); await cancelled.abort();
  held();
  await assert.rejects(expiredPrompt, /fixture mandate expired/); await cancelledPrompt;
  assert(!sent.some(body => body.includes("fixture-expired") || body.includes("fixture-cancelled")));
  const next = await runtime.open("matrix:next");
  try { assert.equal(await next.prompt("fixture-next"), "fixture-ok"); }
  finally { await next.dispose(); }
});
