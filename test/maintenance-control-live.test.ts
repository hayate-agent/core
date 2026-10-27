import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createConnection } from "node:net";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";
import { maintenanceControlPlugin } from "../src/builtin-plugins/maintenance-control-plugin.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

test("socket acknowledges during held prompt; periodic idle work applies once after prompt returns", { timeout: 8000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maintenance-live-"));
  const maintenance = new ContextMaintenance(root, () => defaultContextPolicy);
  // Keep ordinary turn boundaries out of this fixture to exercise the independent idle tick.
  let idle = false;
  const runtime = new FakeRuntime(), h = new Harness({ runtime, tickMs: 60000, contextMaintenance: {
    admissionStatus: key => maintenance.admissionStatus(key),
    guidance: (key, session) => maintenance.guidance(key, session),
    beforeTurn: (key, session, rotate) => maintenance.beforeTurn(key, session, rotate),
    boundary: (key, session, rotate) => idle ? maintenance.boundary(key, session, rotate) : Promise.resolve(undefined),
  } });
  const host = new PluginHost(); h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  let release: (() => void) | undefined;
  try {
    await h.sessionFor("mem:room1"); release = runtime.sessions.get("mem:room1")!.hold();
    await h.submit(msg("work"));
    while (!runtime.sessions.get("mem:room1")!.busy) await new Promise(r => setImmediate(r));
    await host.load([], { home: root, cwd: root, agent: "test" }, [], [], [maintenanceControlPlugin({
      status: () => maintenance.admissionStatus("mem:room1"),
      admit: (id, payload, version) => maintenance.admit("mem:room1", id, payload, version),
      cancel: (id, version) => maintenance.cancelAdmission("mem:room1", id, version),
      maintain: async () => { idle = true; try { return await h.maintainIdle("mem:room1"); } finally { idle = false; } },
    }, path.join(root, "socket"))]);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path.join(root, "socket", "maintenance.sock")); let data = "";
      socket.setEncoding("utf8"); socket.on("error", reject);
      socket.on("connect", () => socket.write(JSON.stringify({ op: "admit", id: "live-1", version: 0,
        request: { action: "compact", preserve: "intent", resume: "next" } }) + "\n"));
      socket.on("data", chunk => { data += chunk; }); socket.on("end", () => resolve(data));
    });
    assert.equal(JSON.parse(response).result.state, "accepted");
    assert.equal(runtime.sessions.get("mem:room1")!.busy, true);
    assert.equal(runtime.sessions.get("mem:room1")!.compacted, 0);
    release(); await h.drained();
    for (let i = 0; i < 40 && (await maintenance.admissionStatus("mem:room1")).execution !== "applied"; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal((await maintenance.admissionStatus("mem:room1")).execution, "applied");
    await new Promise(r => setTimeout(r, 1100));
    assert.equal(runtime.sessions.get("mem:room1")!.compacted, 1);
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
  } finally { release?.(); await host.stop(); await h.stop(1000); await rm(root, { recursive: true, force: true }); }
});
