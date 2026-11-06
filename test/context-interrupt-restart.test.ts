import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { FakeSession } from "./fakes.js";

test("cancelled admitted summary survives restart, retries once and does not duplicate archive/seed", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "interrupt-restart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const policy = () => contextPolicy({ enabled: false, cooldownTurns: 1 });
  const first = new ContextMaintenance(home, policy);
  const old = new FakeSession("old", () => "");
  let enter!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  (old as any).archiveEntries = () => [{ id: "input", role: "user", text: "preserve original intent" }];
  (old as any).summarize = async (_: string, signal: AbortSignal) => {
    enter();
    await new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true }));
    signal.throwIfAborted();
  };
  await first.guidance("key", old);
  const request = { action: "handover" as const, preserve: "original intent", resume: "original continuation" };
  await first.admit("key", "request", request);
  let rotations = 0, seeds = 0, summaries = 0;
  const next = new FakeSession("next", () => "");
  (next as any).seedHandover = async () => { seeds++; };
  const rotate = async () => { rotations++; await (next as any).seedHandover(); return next; };
  const running = first.beforeTurn("key", old, rotate);
  await entered;
  assert.equal(first.interrupt("key"), true);
  await running;
  assert.equal(rotations, 0);
  assert.equal((await first.admissionStatus("key")).execution, "pending");
  assert.equal((await readdir(path.join(home, "session-archives")).catch(() => [])).length, 0);
  // A fresh host instance sees the same request/checkpoint; no in-memory cancellation is needed.
  const restarted = new ContextMaintenance(home, policy);
  (old as any).summarize = async () => { summaries++; return "verified state CURRENT STATE AND NEXT STEPS original continuation"; };
  await restarted.beforeTurn("key", old, rotate); // reserved cooldown still holds
  assert.equal(rotations, 0);
  await restarted.boundary("key", old, rotate); // one actual completed-turn boundary
  await restarted.beforeTurn("key", old, rotate);
  assert.equal((await restarted.admissionStatus("key")).execution, "applied");
  await restarted.guidance("key", next);
  await restarted.beforeTurn("key", next, rotate);
  assert.equal(rotations, 1);
  assert.equal(seeds, 1);
  assert.equal(summaries, 1);
  await restarted.admit("key", "request", request); // exact retry does not re-admit effects
  assert.equal((await restarted.admissionStatus("key")).execution, "applied");
});

test("interrupt never releases a noncooperative maintenance adapter before settlement", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "interrupt-drain-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const maintenance = new ContextMaintenance(home, () => contextPolicy({ enabled: false }));
  const session = new FakeSession("old", () => "");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const gate = new Promise<void>(r => { release = r; });
  session.compact = async () => { enter(); await gate; };
  await maintenance.request("key", { action: "compact", preserve: "intent", resume: "task" });
  const running = maintenance.boundary("key", session, async () => session);
  await entered;
  maintenance.interrupt("key");
  let unlocked = false;
  const guidance = maintenance.guidance("key", session).then(() => { unlocked = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(unlocked, false);
  release(); await running; await guidance;
  assert.equal(unlocked, true);
});
