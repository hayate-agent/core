import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";

test("installed SDK sends opted-in off sampling parameter as reasoning_effort none on HTTP wire", async t => {
  let payload: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    payload = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"{\\"findings\\":[]}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const { streamSimple } = await import("../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js");
  const model = { id: "local", name: "local", api: "openai-completions", provider: "fixture", baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: true,
    input: ["text"], contextWindow: 32000, maxTokens: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    samplingParamsByThinkingLevel: { off: { reasoning_effort: "none" } } };
  const result = await streamSimple(model as never, { messages: [{ role: "user", content: "JSON", timestamp: Date.now() }] }, { apiKey: "fixture" }).result();
  assert.equal(result.stopReason, "stop");
  assert.equal(payload?.reasoning_effort, "none");
});
