import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { McpManagement, mcpArguments, type McpOperator } from "../src/mcp-management.js";
import { SettingsService } from "../src/settings.js";
import { Harness } from "../src/harness.js";
import { installCommands } from "../src/commands.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

async function fixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), "hayate-mcp-management-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsService(path.join(home, "settings.local.yaml"), { mcp: { enabled: false } }); await settings.load();
  let reloads = 0;
  const manager = new McpManagement({ agentDir: home, enabled: () => settings.effective().mcp!.enabled,
    setEnabled: value => settings.setMcpEnabled(value), changed: async () => { reloads++; } });
  t.after(() => manager.close());
  const notifications: string[] = [];
  const op: McpOperator = { cwd: home, owner: "owner/session", notify: text => notifications.push(text) };
  return { home, settings, manager, op, notifications, reloads: () => reloads };
}

test("native MCP CRUD preserves unrelated configuration, persists enablement and hides credentials", async t => {
  const f = await fixture(t);
  assert.match(await f.manager.execute("status", f.op), /disabled/);
  assert.match(await f.manager.execute('add docs https://example.invalid/mcp', f.op), /configuration saved/);
  assert.equal(f.settings.effective().mcp!.enabled, true);
  await f.manager.execute('add local {"command":"node","args":["server.js"],"enabled":false,"env":{"KEY":"${PRIVATE_MCP_KEY}"}}', f.op);
  await f.manager.execute('edit docs {"url":"https://example.invalid/new","enabled":false}', f.op);
  await f.manager.execute('exposure docs direct', f.op);
  const config = JSON.parse(await readFile(path.join(f.home, "mcp.json"), "utf8"));
  assert.equal(config.mcpServers.local.env.KEY, "${PRIVATE_MCP_KEY}");
  assert.equal(config.mcpServers.docs.url, "https://example.invalid/new");
  assert.equal(config.mcpServers.docs.exposure, "direct");
  const status = await f.manager.execute("status", f.op);
  assert.doesNotMatch(status, /PRIVATE_MCP_KEY|server.js|example.invalid/);
  await assert.rejects(f.manager.execute("add docs https://other.invalid/mcp", f.op), /already exists/);
  await f.manager.execute("remove docs", f.op);
  assert.ok(JSON.parse(await readFile(path.join(f.home, "mcp.json"), "utf8")).mcpServers.local);
  await f.manager.execute("disable", f.op);
  const next = new SettingsService(path.join(f.home, "settings.local.yaml"), { mcp: { enabled: true } }); await next.load();
  assert.equal(next.effective().mcp!.enabled, false);
  assert.ok(f.reloads() >= 5);
  assert.equal((await stat(path.join(f.home, "mcp.json"))).mode & 0o777, 0o600);
  await assert.rejects(f.manager.execute('add bad {"type":"sse","url":"https://example.invalid"}', f.op), /Invalid/);
});

test("/mcp routes authenticated user management without model/skill turns, including other gateways", async t => {
  const f = await fixture(t); const runtime = new FakeRuntime(); const channel = new MemoryChannel();
  const h = new Harness({ runtime, tickMs: 60000, topicLabeler: async text => { assert.fail("MCP commands must not reach semantic topic models: " + text); } });
  h.onStateChange = async () => {}; h.addChannel(channel); t.after(() => h.stop(0));
  installCommands({ harness: h, mcp: f.manager, approvals: { mode: "off", tools: [] }, skills: () => [],
    reloadSkills: async () => { assert.fail("MCP command must not fall through to skills"); },
    personality: { available: async () => [], set: async () => {} }, admins: ["owner"], agent: "test", restart: async () => {}, cwdFor: () => f.home });
  await h.submit(msg("/mcp add docs https://example.invalid/mcp", "stranger")); await h.drained();
  assert.match(channel.texts().at(-1)!, /admin only/);
  await h.submit(msg('/mcp add local {"command":"node","enabled":false}', "owner")); await h.drained();
  assert.match(channel.texts().at(-1)!, /configuration saved/);
  await h.submit(msg("/mcp", "owner")); await h.drained();
  assert.match(channel.texts().at(-1)!, /local: disabled/);
  assert.equal(runtime.sessions.size, 0, "no model session was opened");
});

for (const selector of ["server-name", "login-id"] as const) test(`real HTTP MCP OAuth by ${selector}: manual redirect, PKCE, durable credentials, restart and logout`, async t => {
  const f = await fixture(t);
  const token = randomBytes(24).toString("hex");
  let base = "", challenge = "", expectedRedirect = "", exchanges = 0, deletes = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      json({ resource: base + "/mcp", authorization_servers: [base], scopes_supported: ["tools"] }); return;
    }
    if (url.pathname.startsWith("/.well-known/")) {
      json({ issuer: base, authorization_endpoint: base + "/authorize", token_endpoint: base + "/token",
        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true }); return;
    }
    if (url.pathname === "/token") {
      let body = ""; for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      assert.equal(params.get("code"), "browser-code"); assert.equal(params.get("redirect_uri"), expectedRedirect);
      assert.equal(createHash("sha256").update(params.get("code_verifier")!).digest("base64url"), challenge);
      exchanges++; json({ access_token: token, refresh_token: "private-refresh", token_type: "Bearer", expires_in: 3600, scope: "tools" }); return;
    }
    if (url.pathname !== "/mcp") { json({}, 404); return; }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` }).end(); return;
    }
    if (req.method === "DELETE") { deletes++; res.writeHead(204).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = ""; for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : message.method === "tools/list" ? { tools: [{ name: "hello", inputSchema: { type: "object", properties: {} } }] } : {};
    res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "oauth-fixture" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { await f.manager.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await f.manager.execute(`add fixture ${JSON.stringify({ url: base + "/mcp", oauth: { clientId: "fixture-client" }, exposure: "direct" })}`, f.op);
  assert.match(await f.manager.execute("status fixture", f.op), /needs-auth/);
  const started = await f.manager.execute("login fixture", f.op); const id = /Login ([\w-]+)\./.exec(started)![1];
  await t.waitFor(() => assert.ok(f.notifications.some(text => text.includes("/authorize?")), f.notifications.join("\n")), { timeout: 10000 });
  const message = f.notifications.find(text => text.includes("/authorize?"))!;
  assert.ok(message.includes("/mcp auth fixture <redirect-url>"));
  assert.ok(message.includes("/mcp cancel fixture"));
  const auth = new URL(message.split("\n").find(line => line.startsWith(base))!);
  challenge = auth.searchParams.get("code_challenge")!; expectedRedirect = auth.searchParams.get("redirect_uri")!;
  const callback = new URL(expectedRedirect); callback.searchParams.set("code", "browser-code"); callback.searchParams.set("state", auth.searchParams.get("state")!); callback.searchParams.set("iss", base);
  for (const target of [id, "fixture"]) {
    await assert.rejects(f.manager.execute(`auth ${target} ${callback}`, { ...f.op, owner: "different/user" }), /not found/);
    await assert.rejects(f.manager.execute(`auth ${target} ${callback}`, { ...f.op, owner: "owner/different-session" }), /not found/);
  }
  await assert.rejects(f.manager.execute(`auth unknown ${callback}`, f.op), /not found/);
  assert.equal(exchanges, 0);
  await f.manager.execute(`auth ${selector === "server-name" ? "fixture" : id} ${callback}`, f.op);
  await t.waitFor(() => assert.ok(f.notifications.some(text => /Login .*: complete/.test(text)), f.notifications.join("\n")), { timeout: 10000 });
  assert.equal(exchanges, 1);
  await t.waitFor(() => assert.ok(deletes > 0), { timeout: 5000 });
  assert.doesNotMatch(f.notifications.join("\n"), new RegExp(token + "|private-refresh|browser-code"));
  assert.equal((await stat(path.join(f.home, "mcp-auth.json"))).mode & 0o777, 0o600);
  assert.ok((await readFile(path.join(f.home, "mcp-auth.json"), "utf8")).includes(token));
  for (const target of [id, "fixture"]) await assert.rejects(f.manager.execute(`auth ${target} ${callback}`, f.op), /no longer pending/);
  const restarted = new McpManagement({ agentDir: f.home, enabled: () => true, setEnabled: async () => {}, changed: async () => {} }); t.after(() => restarted.close());
  assert.match(await restarted.execute("tools fixture", f.op), /connected[\s\S]*hello/);
  await restarted.execute("logout fixture", f.op);
  assert.ok(!(await readFile(path.join(f.home, "mcp-auth.json"), "utf8")).includes(token));
  assert.match(await restarted.execute("status fixture", f.op), /needs-auth/);

  const start = await restarted.execute("login fixture", f.op);
  const browserId = /Login ([\w-]+)\./.exec(start)![1];
  await t.waitFor(() => assert.ok(f.notifications.some(text => text.includes(`Login: ${browserId}`))), { timeout: 10000 });
  const browserNotice = f.notifications.find(text => text.includes(`Login: ${browserId}`))!;
  const browserAuth = new URL(browserNotice.split("\n").find(line => line.startsWith(base))!);
  challenge = browserAuth.searchParams.get("code_challenge")!; expectedRedirect = browserAuth.searchParams.get("redirect_uri")!;
  const directCallback = new URL(expectedRedirect); directCallback.searchParams.set("code", "browser-code");
  directCallback.searchParams.set("state", browserAuth.searchParams.get("state")!); directCallback.searchParams.set("iss", base);
  assert.ok((await fetch(directCallback)).ok, "browser callback can also reach the agent directly");
  await t.waitFor(() => assert.ok(f.notifications.some(text => text.includes(`Login ${browserId}: complete`))), { timeout: 10000 });
  assert.equal(exchanges, 2);
  await restarted.execute("logout fixture", f.op);

  const cancelStart = await restarted.execute("login fixture", f.op); const cancelId = /Login ([\w-]+)\./.exec(cancelStart)![1];
  await t.waitFor(() => assert.ok(f.notifications.some(text => text.includes(`Login: ${cancelId}`))), { timeout: 10000 });
  for (const target of [cancelId, "fixture"]) await assert.rejects(restarted.execute(`cancel ${target}`, { ...f.op, owner: "other-conversation" }), /not found/);
  await restarted.execute(`cancel ${selector === "server-name" ? "fixture" : cancelId}`, f.op);
  await t.waitFor(() => assert.ok(f.notifications.some(text => text.includes(`Login ${cancelId}.`) && text.includes("cancelled"))), { timeout: 10000 });
  assert.equal(exchanges, 2, "cancelled sign-in performs no token exchange");
  assert.ok(!(await readFile(path.join(f.home, "mcp-auth.json"), "utf8")).includes(token));
});

test("native TUI MCP menu adds and manages stdio, with shutdown of probe children", async t => {
  const f = await fixture(t); const server = path.join(f.home, "stdio.mjs"), pidFile = path.join(f.home, "pid");
  await writeFile(server, `import {createInterface}from'node:readline';import{writeFileSync}from'node:fs';writeFileSync(process.argv[2],String(process.pid));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'stdio_echo',inputSchema:{type:'object',properties:{}}}]}:{};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
  const answers = ["fixture", process.execPath, `"${server}" "${pidFile}"`], wizard = ["+add", "stdio"];
  const ui = { select: async () => wizard.shift()!, prompt: async () => answers.shift()!, confirm: async () => true,
    custom: async () => "", notify: () => {} };
  assert.match(await f.manager.menu({ ...f.op, ui }), /configuration saved/);
  assert.match(await f.manager.execute("tools fixture", f.op), /connected[\s\S]*stdio_echo/);
  const pid = Number(await readFile(pidFile, "utf8")); assert.throws(() => process.kill(pid, 0));
  const choices = ["fixture", "disconnect"];
  assert.match(await f.manager.menu({ ...f.op, ui: { ...ui, select: async () => choices.shift()! } }), /disabled/);
  assert.match(await f.manager.execute("status fixture", f.op), /fixture: disabled/);
  await f.manager.execute(`add second -- "${process.execPath}" "${server}" "${pidFile}"`, f.op);
  await f.manager.execute("disable second", f.op);
  assert.deepEqual(mcpArguments(`--flag 'one two' "" '$HOME' '$(touch marker)'`), ["--flag", "one two", "", "$HOME", "$(touch marker)"]);
  assert.throws(() => mcpArguments('"unclosed'), /Unclosed/);
});

test("MCP command uses configured system language for help and safe errors", async t => {
  const f = await fixture(t); const channel = new MemoryChannel();
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  h.onStateChange = async () => {}; h.addChannel(channel); t.after(() => h.stop(0));
  installCommands({ harness: h, mcp: f.manager, language: { get: () => ({ system: "de", mcp: { missing: "es" } }), update: async () => {} },
    approvals: { mode: "off", tools: [] }, skills: () => [], reloadSkills: async () => {},
    personality: { available: async () => [], set: async () => {} }, admins: ["owner"], agent: "test", restart: async () => {}, cwdFor: () => f.home });
  await h.submit(msg("/mcp help", "owner")); await h.drained();
  assert.match(channel.texts().at(-1)!, /MCP-Verwaltung/);
  assert.match(channel.texts().at(-1)!, /\/mcp auth <server-name\|login-id> <browser-redirect-url>/);
  await h.submit(msg("/mcp status missing", "owner")); await h.drained();
  assert.match(channel.texts().at(-1)!, /MCP-Server nicht gefunden/);
});

test("MCP asynchronous login failure retains the initiating operator language", async t => {
  const f = await fixture(t);
  const server = path.join(f.home, "stdio-language.mjs");
  await writeFile(server, `import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});`);
  await f.manager.execute(`add fixture ${JSON.stringify({ command: process.execPath, args: [server] })}`, f.op);
  const op = { ...f.op, language: "de" };
  assert.match(await f.manager.execute("login fixture", op), /Anmeldung gestartet\. Anmeldung [\w-]+\./);
  op.language = "es";
  await t.waitFor(() => assert.ok(f.notifications.some(text => /Anmeldung fehlgeschlagen/.test(text))), { timeout: 10000 });
  assert.doesNotMatch(f.notifications.join("\n"), /inicio de sesión/);
});

test("German MCP status and immediate actions retain identifiers and redact configuration", async t => {
  const f = await fixture(t);
  const op = { ...f.op, language: "de" };
  assert.match(await f.manager.execute("status", op), /MCP: deaktiviert/);
  assert.match(await f.manager.execute('add local {"command":"node","enabled":false,"env":{"KEY":"${PRIVATE_KEY}"}}', op), /Konfiguration gespeichert; deaktiviert/);
  const status = await f.manager.execute("status", op);
  assert.match(status, /local: deaktiviert \(codemode\)/);
  assert.doesNotMatch(status, /PRIVATE_KEY|node/);
  assert.match(await f.manager.execute("remove local", op), /MCP local: entfernt/);
  await assert.rejects(f.manager.execute("status local", op), /MCP-Server/);
});
