// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);

test("real MCP HTTP client authenticates, calls tools, closes session and rejects invalid bearer", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-http-"));
  const token = randomBytes(24).toString("hex");
  const calls: string[] = [];
  let denied = 0;
  let invalidSession = false;
  let validSessionDelete = false;
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      denied++;
      res.writeHead(401).end();
      return;
    }
    if (req.method === "DELETE") {
      calls.push("DELETE");
      validSessionDelete = req.headers["mcp-session-id"] === "fixture-session";
      res.writeHead(validSessionDelete ? 204 : 400).end();
      return;
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const part of req) body += part;
    const message = JSON.parse(body);
    calls.push(message.method);
    if (message.method !== "initialize" && req.headers["mcp-session-id"] !== "fixture-session") invalidSession = true;
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "echo", description: "HTTP fixture", inputSchema: { type: "object", properties: {} } }] }
        : message.method === "tools/call" ? { content: [{ type: "text", text: "authenticated HTTP reply" }] } : {};
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    await writeFile(path.join(home, "mcp.json"), JSON.stringify({ mcpServers: { fixture: {
      url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: "Bearer ${HARNESS_TEST_MCP_TOKEN}" }, exposure: "direct",
    } } }));
    const code = `
import assert from 'node:assert/strict';
import {PiRuntime} from './src/runtime/pi.ts';
const runtime=new PiRuntime({cwd:process.env.TEST_HOME,sessionsDir:process.env.TEST_HOME+'/sessions',skillPaths:[],personaSections:async()=>[],approvals:{mode:'off',tools:[]},mcp:{enabled:true}});
const wrapped=await runtime.open('http-fixture');
try {
 const session=wrapped.session;
 const expected=process.env.EXPECT_AUTH==='yes';
 const deadline=Date.now()+(expected?5000:1000);
 while(!session.getAllTools().some(t=>t.name==='mcp__fixture__echo') && Date.now()<deadline) await new Promise(r=>setTimeout(r,20));
 const definition=session.extensionRunner.getToolDefinition('mcp__fixture__echo');
 assert.equal(Boolean(definition),expected);
 if(expected){
   const reply=await definition.execute('call',{},undefined,undefined,{});
   assert.equal(reply.content[0].text,'authenticated HTTP reply');
 }
} finally {await wrapped.dispose()}
console.log('HTTP_TEST_OK');`;
    for (const valid of [true, false]) {
      const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        env: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_HOME: home, HARNESS_TEST_MCP_TOKEN: valid ? token : "invalid", EXPECT_AUTH: valid ? "yes" : "no" },
        timeout: 15000,
      });
      assert.match(result.stdout, /HTTP_TEST_OK/);
      assert.ok(!result.stdout.includes(token));
      assert.ok(!result.stderr.includes(token));
    }
    assert.equal(invalidSession, false, "subsequent requests preserve the negotiated session ID");
    assert.equal(calls.filter((method) => method === "tools/call").length, 1, "invalid bearer cannot execute a tool");
    assert.ok(calls.includes("initialize"));
    assert.ok(calls.includes("tools/call"));
    assert.ok(calls.includes("DELETE"), "shutdown terminates the HTTP session");
    assert.equal(validSessionDelete, true, "DELETE must identify the negotiated HTTP session");
    assert.ok(denied > 0, "bad bearer must reach and be rejected by server");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
