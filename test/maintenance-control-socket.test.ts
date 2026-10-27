import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createConnection } from "node:net";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { PluginHost } from "../src/plugins.js";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";
import { maintenanceControlPlugin } from "../src/builtin-plugins/maintenance-control-plugin.js";

function request(endpoint: string, frame: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint); let data = "";
    socket.setEncoding("utf8"); socket.on("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify(frame) + "\n"));
    socket.on("data", part => { data += part; });
    socket.once("end", () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
  });
}

test("typed local maintenance receipts are durable and errors sanitized; arbitrary scope is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-control-"));
  const maintenance = new ContextMaintenance(root, () => defaultContextPolicy), host = new PluginHost();
  const directory = path.join(root, "socket"), endpoint = path.join(directory, "maintenance.sock");
  try {
    await host.load([], { home: root, cwd: root, agent: "test" }, [], [], [maintenanceControlPlugin({
      status: () => maintenance.admissionStatus("fixed"),
      admit: (id, payload, version) => maintenance.admit("fixed", id, payload, version),
      cancel: (id, version) => maintenance.cancelAdmission("fixed", id, version),
      maintain: async () => "deferred",
    }, directory)]);
    assert.deepEqual(await request(endpoint, { op: "status" }), { ok: true, result: { version: 0 } });
    const frame = { op: "admit", id: "test-1", version: 0, request: { action: "compact", preserve: "SECRET", resume: "next" } };
    assert.equal((await request(endpoint, frame)).result.state, "accepted");
    assert.equal((await request(endpoint, frame)).result.version, 1);
    const status = await request(endpoint, { op: "status" });
    assert.equal(status.result.execution, "pending"); assert.ok(!JSON.stringify(status).includes("SECRET"));
    assert.equal((await request(endpoint, { op: "status", sessionKey: "other" })).ok, false);
    assert.equal((await request(endpoint, { op: "exec", command: "anything" })).ok, false);
    assert.equal((await request(endpoint, { op: "cancel", id: "test-1", version: -1 })).ok, false);
    assert.equal((await request(endpoint, { op: "cancel", id: "test-1", version: 1, extra: true })).ok, false);
    assert.equal((await request(endpoint, { ...frame, request: { ...frame.request, resume: "different" } })).error, "request rejected");
    assert.equal((await request(endpoint, { op: "cancel", id: "test-1", version: 1 })).ok, true);
    assert.equal((await maintenance.admissionStatus("fixed")).execution, "cancelled");
  } finally { await host.stop(); await rm(root, { recursive: true, force: true }); }
});
