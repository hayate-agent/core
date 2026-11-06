// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const interruption of ["pause", "stop"] as const) {
  test(`${interruption} during receipt lookup fences idle effects`, async () => {
    const runtime = new FakeRuntime();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const started = new Promise<void>(r => { entered = r; });
    let effects = 0;
    const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: {
      admissionStatus: async () => { entered(); await gate; return { execution: "pending" }; },
      guidance: async () => { effects++; return ""; }, boundary: async () => { effects++; return undefined; },
    } });
    h.onStateChange = async () => {};
    try {
      await h.sessionFor("chat");
      const pending = h.maintainIdle("chat"); await started;
      if (interruption === "pause") h.paused = true;
      else await h.stopConversation("chat");
      release();
      assert.equal(await pending, "deferred");
      assert.equal(effects, 0);
      assert.equal(runtime.sessions.get("chat")!.prompts.length, 0);
    } finally { release?.(); await h.stop(0); }
  });
}

test("busy working prompt defers maintenance without opening another runtime", async () => {
  const runtime = new FakeRuntime(); let checks = 0;
  const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: {
    admissionStatus: async () => { checks++; return { execution: "pending" }; },
    guidance: async () => "", boundary: async () => undefined,
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  let release: (() => void) | undefined;
  try {
    await h.sessionFor("mem:room1"); release = runtime.sessions.get("mem:room1")!.hold();
    await h.submit(msg("work"));
    while (!runtime.sessions.get("mem:room1")!.busy) await new Promise(r => setImmediate(r));
    assert.equal(await h.maintainIdle("mem:room1"), "deferred");
    assert.equal(checks, 0);
    assert.equal(runtime.opened.length, 1);
    release(); await h.drained();
  } finally { release?.(); await h.stop(0); }
});

test("queued operator input during receipt lookup takes precedence over idle maintenance", async () => {
  const runtime = new FakeRuntime(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  let boundaryCalls = 0;
  const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: {
    admissionStatus: async () => { entered(); await gate; return { execution: "pending" }; },
    guidance: async () => "", boundary: async () => { boundaryCalls++; return undefined; },
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.sessionFor("mem:room1");
    const idle = h.maintainIdle("mem:room1"); await started;
    await h.submit(msg("new operator work"));
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 0);
    release(); assert.equal(await idle, "deferred");
    await h.drained();
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
    assert.equal(boundaryCalls, 1, "only the working turn, not idle maintenance, ran its boundary");
  } finally { release?.(); await h.stop(0); }
});

test("shutdown does not claim to cancel an already entered maintenance effect", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  let effects = 0;
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, contextMaintenance: {
    admissionStatus: async () => ({ execution: "pending" }), guidance: async () => "",
    boundary: async () => { entered(); await gate; effects++; return undefined; },
  } });
  h.onStateChange = async () => {};
  try {
    await h.sessionFor("chat"); const work = h.maintainIdle("chat"); await started;
    const stopping = h.stop(0);
    release(); await work; await stopping;
    assert.equal(effects, 1, "entered effect is not falsely reported as hard-cancelled");
    assert.equal(await h.maintainIdle("chat"), "deferred");
  } finally { release?.(); await h.stop(0); }
});

test("failed handover candidate is disposed without replacing the owner", async () => {
  const runtime = new FakeRuntime(); let disposed = 0;
  const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: {
    admissionStatus: async () => ({ execution: "pending" }), guidance: async () => "",
    beforeTurn: async (_key, _session, rotate) => { await rotate({ phase: "prepared", from: "old", text: "checkpoint" }); return undefined; },
    boundary: async () => undefined,
  } });
  h.onStateChange = async () => {};
  try {
    const owner = await h.sessionFor("chat");
    const open = runtime.open.bind(runtime);
    runtime.open = async (...args) => { const candidate = await open(...args); candidate.dispose = () => { disposed++; }; return candidate; };
    await assert.rejects(h.maintainIdle("chat"), /seed handover/);
    assert.equal(disposed, 1);
    assert.equal(h.sessions.get("chat")!.session, owner);
    assert.equal(h.sessions.get("chat")!.running, false);
  } finally { await h.stop(0); }
});

test("stop during handover seeding disposes candidate without publishing it", async () => {
  const runtime = new FakeRuntime(); let disposed = 0;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: {
    admissionStatus: async () => ({ execution: "pending" }), guidance: async () => "",
    beforeTurn: async (_key, _session, rotate) => { await rotate({ phase: "prepared", from: "old", text: "checkpoint" }); return undefined; },
    boundary: async () => undefined,
  } });
  h.onStateChange = async () => {};
  try {
    const owner = await h.sessionFor("chat");
    const open = runtime.open.bind(runtime);
    runtime.open = async (...args) => {
      const candidate = await open(...args);
      Object.assign(candidate, { seedHandover: async () => { entered(); await gate; } });
      candidate.dispose = () => { disposed++; }; return candidate;
    };
    const work = h.maintainIdle("chat"); await started;
    await h.stopConversation("chat"); release();
    await assert.rejects(work, /interrupted during seeding/);
    assert.equal(h.sessions.get("chat")!.session, owner);
    assert.equal(disposed, 1);
    assert.equal(h.sessions.get("chat")!.running, false);
  } finally { release?.(); await h.stop(0); }
});

test("explicit pending compaction runs at idle without a working prompt; pause defers it", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-idle-"));
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  const runtime = new FakeRuntime(), h = new Harness({ runtime, contextMaintenance: maintenance, tickMs: 60000 });
  h.onStateChange = async () => {};
  try {
    await h.sessionFor("chat");
    await maintenance.admit("chat", "idle-1", { action: "compact", preserve: "intent", resume: "next" });
    h.paused = true;
    assert.equal(await h.maintainIdle("chat"), "deferred");
    h.paused = false;
    assert.equal(await h.maintainIdle("chat"), "processed");
    assert.equal(runtime.sessions.get("chat")!.compacted, 1);
    assert.equal(runtime.sessions.get("chat")!.prompts.length, 0);
    assert.equal((await maintenance.admissionStatus("chat")).execution, "applied");
    assert.equal(await h.maintainIdle("chat"), "deferred");
    assert.equal(runtime.sessions.get("chat")!.compacted, 1);
    assert.equal(await h.maintainIdle("missing"), "deferred");
    assert.equal(runtime.opened.length, 1);
  } finally { await h.stop(0); await rm(home, { recursive: true, force: true }); }
});
