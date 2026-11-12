import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const exec = promisify(execFile);
import { maintenanceClient } from "../src/builtin-plugins/maintenance-client.js";

for (const response of [
  { name: "safe status", value: '{"ok":true,"result":{"version":1,"id":"req-1","execution":"pending","secret":"DO_NOT_PRINT"}}', valid: true },
  { name: "initial status", value: '{"ok":true,"result":{"version":0}}', valid: true },
  { name: "incomplete nonzero receipt", value: '{"ok":true,"result":{"version":1}}', valid: false },
  { name: "zero with execution", value: '{"ok":true,"result":{"version":0,"execution":"applied"}}', valid: false },
  { name: "zero with identity", value: '{"ok":true,"result":{"version":0,"id":"req-1"}}', valid: false },
  { name: "malformed", value: 'not-json', valid: false },
  { name: "rejection", value: '{"ok":false,"error":"SECRET"}', valid: false },
  { name: "terminal injection", value: JSON.stringify({ ok: true, result: { version: 1, id: '\u001b[31m' } }), valid: false },
  { name: "oversized", value: 'x'.repeat(5000), valid: false },
]) test(`maintenance client ${response.name}`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-client-")), endpoint = path.join(root, "socket");
  const server = createServer(socket => { socket.on("error", () => {}); socket.once("data", () => socket.end(response.value)); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  try {
    if (response.valid) {
      const text = await maintenanceClient([endpoint, "status"]);
      assert.equal(text, response.name === "initial status" ? '{"version":0}' : '{"version":1,"id":"req-1","execution":"pending"}');
      assert.ok(!text.includes("DO_NOT_PRINT"));
    } else await assert.rejects(maintenanceClient([endpoint, "status"]), /response/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("admit loads bounded file payload and sends exactly one explicit mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-file-")), endpoint = path.join(root, "socket"), file = path.join(root, "request.json");
  const payload = { action: "compact", preserve: "intent", resume: "next" }; await writeFile(file, JSON.stringify(payload));
  let calls = 0;
  const server = createServer(socket => { socket.on("error", () => {}); socket.once("data", data => {
    calls++; assert.deepEqual(JSON.parse(data.toString()), { op: "admit", id: "req-1", version: 0, request: payload });
    socket.end('{"ok":true,"result":{"id":"req-1","version":1,"state":"accepted"}}');
  }); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  try {
    assert.equal(await maintenanceClient([endpoint, "admit", "req-1", "0", file]), '{"version":1,"id":"req-1","state":"accepted"}');
    assert.equal(calls, 1);
    await writeFile(file, "x".repeat(20001));
    await assert.rejects(maintenanceClient([endpoint, "admit", "req-2", "1", file]), /oversized/);
    assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(maintenanceClient([endpoint, "status"], controller.signal), /cancelled/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});


test("fragmented cancel receipt and real CLI bypass invalid agent home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-cli-")), endpoint = path.join(root, "socket");
  let rejected = false;
  const server = createServer(socket => { socket.on("error", () => {}); socket.once("data", () => {
    socket.write(rejected ? '{"ok":false,' : '{"ok":true,"result":');
    setImmediate(() => socket.end(rejected ? '"error":"SECRET"}' : '{"cancelled":true}}'));
  }); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  try {
    assert.equal(await maintenanceClient([endpoint, "cancel", "req-1", "1"]), '{"cancelled":true}');
    const env = { ...process.env, HAYATE_AGENT_HOME: path.join(root, "missing-home") };
    const result = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", "maintenance", endpoint, "cancel", "req-1", "1"], { env, timeout: 15000 });
    assert.equal(result.stdout.trim(), '{"cancelled":true}');
    rejected = true;
    await assert.rejects(exec(process.execPath, ["--import", "tsx", "src/cli.ts", "maintenance", endpoint, "cancel", "req-1", "1"], { env, timeout: 15000 }), (error: any) => {
      assert.equal(error.code, 1); assert.ok(!error.stderr.includes("SECRET")); return true;
    });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("pending abort does not retry and FIFO payload cannot block file admission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-abort-")), endpoint = path.join(root, "socket");
  let received!: () => void; const started = new Promise<void>(resolve => { received = resolve; }); let calls = 0;
  const server = createServer(socket => { socket.on("error", () => {}); socket.once("data", () => { calls++; received(); }); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  try {
    const controller = new AbortController();
    const pending = maintenanceClient([endpoint, "status"], controller.signal);
    await started; controller.abort();
    await assert.rejects(pending, /cancelled/); assert.equal(calls, 1);
    const fifo = path.join(root, "fifo"); await exec("mkfifo", [fifo]);
    await assert.rejects(maintenanceClient([endpoint, "admit", "req-1", "0", fifo]), /request file/);
    await assert.rejects(maintenanceClient([endpoint, "cancel", "req-1", "9007199254740992"]), /identity/);
    assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("absolute response timeout rejects without retrying", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-timeout-")), endpoint = path.join(root, "socket"); let calls = 0;
  const server = createServer(socket => { socket.on("error", () => {}); socket.once("data", () => { calls++; }); });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  try {
    await assert.rejects(maintenanceClient([endpoint, "status"]), /timed out/);
    assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
