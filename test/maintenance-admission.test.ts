import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { RuntimeSession } from "../src/types.js";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";

test("write failure after successful load does not acknowledge or retain an in-memory receipt", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-write-"));
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  const request = { action: "compact" as const, preserve: "intent", resume: "next" };
  try {
    // Inject the existing durable save boundary, after real loading and validation.
    const internal = maintenance as unknown as { save: (...args: unknown[]) => Promise<void> };
    const save = internal.save.bind(maintenance);
    internal.save = async () => { throw Error("write failed"); };
    await assert.rejects(maintenance.admit("chat", "write-1", request), /write failed/);
    assert.deepEqual(await maintenance.admissionStatus("chat"), { version: 0 });
    internal.save = save;
    await maintenance.admit("chat", "write-1", request);
    assert.equal((await maintenance.admissionStatus("chat")).version, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("first owner binding preserves admitted intent and malformed receipts fail closed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-binding-"));
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  try {
    await maintenance.admit("chat", "binding-1", { action: "compact", preserve: "intent", resume: "next" });
    const session = { status: () => ({ sessionId: "first", contextPercent: 0 }) } as RuntimeSession;
    await maintenance.guidance("chat", session);
    assert.equal((await maintenance.admissionStatus("chat")).execution, "pending");
    assert.ok((await maintenance.status("chat")).pending);
    const { createHash } = await import("node:crypto");
    const file = path.join(home, "context-maintenance", createHash("sha256").update("chat").digest("hex") + ".json");
    await writeFile(file, JSON.stringify({ version: 1, turns: 0, lastMaintenance: 0, admission: { id: "binding-1", digest: "invalid", version: -1, execution: "applied" } }));
    await assert.rejects(maintenance.admissionStatus("chat"), /Invalid maintenance admission state/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("unavailable storage never acknowledges admission and a retry can succeed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-save-"));
  const directory = path.join(home, "context-maintenance");
  const request = { action: "compact" as const, preserve: "intent", resume: "next" };
  try {
    await mkdir(directory);
    const { createHash } = await import("node:crypto");
    const file = path.join(directory, createHash("sha256").update("chat").digest("hex") + ".json");
    // Establish valid storage, then make it unavailable before admission.
    await writeFile(file, JSON.stringify({ version: 1, turns: 0, lastMaintenance: -1000 }));
    const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
    // Replace the parent with a file: load sees ENOTDIR, never a successful receipt.
    await rm(directory, { recursive: true }); await writeFile(directory, "blocked");
    await assert.rejects(maintenance.admit("chat", "retry-1", request, 0));
    await rm(directory); await mkdir(directory);
    assert.deepEqual(await maintenance.admissionStatus("chat"), { version: 0 });
    assert.deepEqual(await maintenance.admit("chat", "retry-1", request, 0), { id: "retry-1", version: 1, state: "accepted" });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("pause and owner shutdown retain pending maintenance until explicit cancellation", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-stop-"));
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  try {
    h.paused = true;
    await maintenance.admit("chat", "stop-1", { action: "compact", preserve: "intent", resume: "next" });
    await h.stop(0);
    const restarted = new ContextMaintenance(home, () => defaultContextPolicy);
    assert.equal((await restarted.admissionStatus("chat")).execution, "pending");
    await restarted.cancelAdmission("chat", "stop-1", 1);
    assert.equal((await restarted.admissionStatus("chat")).execution, "cancelled");
  } finally { await h.stop(0); await rm(home, { recursive: true, force: true }); }
});

test("admission is responsive during a held owner prompt and does not execute maintenance immediately", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-held-"));
  const runtime = new FakeRuntime(), h = new Harness({ runtime, tickMs: 60000 });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  let release: (() => void) | undefined;
  try {
    await h.sessionFor("mem:room1"); release = runtime.sessions.get("mem:room1")!.hold();
    await h.submit(msg("work"));
    while (!runtime.sessions.get("mem:room1")!.busy) await new Promise(r => setImmediate(r));
    const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
    await maintenance.admit("mem:room1", "held-1", { action: "compact", preserve: "intent", resume: "next" }, 0);
    assert.equal(runtime.sessions.get("mem:room1")!.busy, true);
    assert.equal(runtime.sessions.get("mem:room1")!.compacted, 0);
    assert.equal((await new ContextMaintenance(home, () => defaultContextPolicy).status("mem:room1")).admission?.version, 1);
    await assert.rejects(maintenance.cancelAdmission("mem:room1", "held-1", 0), /version conflict/);
    await maintenance.cancelAdmission("mem:room1", "held-1", 1);
    await maintenance.cancelAdmission("mem:room1", "held-1", 1);
    assert.equal((await maintenance.admissionStatus("mem:room1")).execution, "cancelled");
    assert.equal((await maintenance.status("mem:room1")).pending, undefined);
    assert.equal(runtime.sessions.get("mem:room1")!.busy, true);
    release(); await h.drained();
  } finally { release?.(); await h.stop(1000); await rm(home, { recursive: true, force: true }); }
});

test("identified admission is durable, idempotent and does not overwrite pending work", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "maintenance-admission-"));
  const request = { action: "compact" as const, preserve: "intent", resume: "next task" };
  try {
    const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
    assert.deepEqual(await maintenance.admit("chat", "request-1", request), { id: "request-1", version: 1, state: "accepted" });
    const restarted = new ContextMaintenance(home, () => defaultContextPolicy);
    assert.deepEqual(await restarted.admit("chat", "request-1", request), { id: "request-1", version: 1, state: "accepted" });
    await assert.rejects(restarted.admit("chat", "request-1", { ...request, resume: "different" }), /conflict/);
    await assert.rejects(restarted.admit("chat", "request-2", request, 1), /pending/);
    assert.equal((await restarted.status("chat")).pending?.resume, "next task");
    await assert.rejects(restarted.request("chat", request), /Identified maintenance already pending/);
    let compacted = 0;
    const session = { status: () => ({ sessionId: "session-1", contextPercent: 5 }), compact: async () => { compacted++; } } as unknown as RuntimeSession;
    const rotate = async (): Promise<RuntimeSession> => { throw Error("unexpected rotation"); };
    await restarted.boundary("chat", session, rotate);
    assert.equal(compacted, 1);
    assert.deepEqual(await restarted.admissionStatus("chat"), { id: "request-1", version: 1, execution: "applied" });
    const again = new ContextMaintenance(home, () => defaultContextPolicy);
    assert.deepEqual(await again.admit("chat", "request-2", request, 1), { id: "request-2", version: 2, state: "accepted" });
    await assert.rejects(again.admit("chat", "request-1", request, 0), /version conflict/);
    assert.equal((await again.status("chat")).admission?.version, 2);
    await again.boundary("chat", session, rotate);
    assert.equal(compacted, 2);
    assert.deepEqual(await again.admit("chat", "request-2", request, 1), { id: "request-2", version: 2, state: "accepted" });
    assert.equal((await again.status("chat")).pending, undefined);
    assert.equal(compacted, 2, "replayed receipt must not schedule another compaction");
    assert.equal((await again.admissionStatus("chat")).execution, "applied");
    await again.admit("chat", "request-3", request, 2);
    const changed = { status: () => ({ sessionId: "session-2", contextPercent: 5 }) } as RuntimeSession;
    await again.guidance("chat", changed);
    assert.deepEqual(await again.admissionStatus("chat"), { id: "request-3", version: 3, execution: "superseded" });
    assert.equal((await again.status("chat")).pending, undefined);
    await again.admit("chat", "request-4", request, 3);
    const failing = { status: () => ({ sessionId: "session-2", contextPercent: 5 }), compact: async () => { throw Error("SECRET_DISK"); } } as unknown as RuntimeSession;
    await again.boundary("chat", failing, rotate);
    assert.equal((await again.status("chat")).pending?.action, "handover");
    // This deliberately incomplete runtime cannot archive a handover. That is
    // a genuine prerequisite failure, unlike the original compact failure.
    await again.beforeTurn("chat", failing, rotate);
    const receipt = await again.admissionStatus("chat");
    assert.deepEqual({ ...receipt, recovery: undefined }, { id: "request-4", version: 4, execution: "failed", recovery: undefined });
    assert.equal(receipt.recovery?.state, "blocked");
    assert.equal(receipt.recovery?.reason, "uncertain");
    assert.ok(!JSON.stringify(await again.admissionStatus("chat")).includes("SECRET"));
    assert.ok((await again.status("chat")).pending, "failed maintenance retains recovery intent");
    await assert.rejects(again.cancelAdmission("chat", "request-4", 4), /cannot be cancelled/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
