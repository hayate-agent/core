import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController, improvementPolicy } from "../src/improvement.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import bundled from "../src/builtin-plugins/nightly-default.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-boundary-"));
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  const controller = new ImprovementController(home, harness, "UTC", () => Date.parse("2026-10-27T12:00:00Z"), bundled);
  t.after(async () => { await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  return { home, harness, controller };
}

test("strategy reservation rejects an awaited tick and blocks ticks until publication finishes", async t => {
  const { controller } = await fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  controller.policy = async () => { entered(); await gate; return improvementPolicy(); };
  const tick = controller.tick(false); await started;
  await assert.rejects(controller.atStrategyBoundary(async () => {}), /Nightly strategy busy/);
  release(); await tick;
  let calls = 0;
  controller.policy = async () => { calls++; return improvementPolicy(); };
  await controller.atStrategyBoundary(async () => {
    await controller.tick(true); assert.equal(calls, 0);
    await assert.rejects(controller.atStrategyBoundary(async () => {}), /Nightly strategy busy/);
  });
  await controller.tick(false); assert.equal(calls, 1);
});

for (const state of [
  { pending: "old-turn", reportQueued: true },
  { done: true, reportQueued: false },
  { done: true },
]) test(`strategy refuses unresolved persisted night ${JSON.stringify(state)}`, async t => {
  const { home, controller } = await fixture(t);
  await mkdir(path.join(home, "improvement"));
  await writeFile(path.join(home, "improvement/state.json"), JSON.stringify({ version: 1, night: "2026-10-26", turns: 1, results: [], ...state }));
  let applied = false;
  await assert.rejects(controller.atStrategyBoundary(async () => { applied = true; }), /Unreported or pending/);
  assert.equal(applied, false);
});

test("actual report adoption holds strategy reservation until durable owner save completes", async t => {
  const { home, harness, controller } = await fixture(t);
  await mkdir(path.join(home, "improvement"));
  await writeFile(path.join(home, "improvement/state.json"), JSON.stringify({
    version: 1, night: "2026-10-26", turns: 1, results: ["old result"], done: true,
  }));
  const channel = new MemoryChannel(); harness.addChannel(channel);
  harness.home = { channel: "mem", target: "report" };
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saving = new Promise<void>(resolve => { entered = resolve; });
  harness.onStateChange = async () => { entered(); await gate; };
  const tick = controller.tick(false);
  try {
    await saving;
    await assert.rejects(controller.atStrategyBoundary(async () => {}), /Nightly strategy busy/);
  } finally { release(); await tick; }
  // Outbox adoption is not remote delivery. Drain it before switching.
  await harness.tick(); await harness.drained();
  await controller.atStrategyBoundary(async () => {});
  assert.equal(channel.sent.length, 1);
});

test("held real owner turn refuses a strategy change without aborting it", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-held-"));
  const runtime = new FakeRuntime(), harness = new Harness({ runtime, tickMs: 60000 });
  harness.addChannel(new MemoryChannel());
  const controller = new ImprovementController(home, harness, "UTC", Date.now, bundled);
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  t.after(async () => { release(); await harness.stop(1000); await rm(home, { recursive: true, force: true }); });
  await harness.submit(msg("held work"));
  while (!runtime.sessions.get("mem:room1")!.busy) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(controller.atStrategyBoundary(async () => {}), /idle turn boundary/);
  assert.equal(runtime.sessions.get("mem:room1")!.busy, true);
  assert.equal(runtime.sessions.get("mem:room1")!.aborted, 0);
  release(); await harness.drained();
  await controller.atStrategyBoundary(async () => {});
});

test("strategy allows adopted prior report but refuses queued owner work; failed callback releases reservation", async t => {
  const { home, controller, harness } = await fixture(t);
  await mkdir(path.join(home, "improvement"));
  await writeFile(path.join(home, "improvement/state.json"), JSON.stringify({ version: 1, night: "2026-10-26", turns: 1, results: [], reportQueued: true }));
  await controller.atStrategyBoundary(async () => {});
  harness.paused = true;
  harness.enqueue({ id: "queued", sessionKey: "improvement:nightly", source: "cron", text: "work" });
  await assert.rejects(controller.atStrategyBoundary(async () => {}), /Nightly strategy busy|idle turn boundary/);
  // Separate controller has no queued owner work and can recover after a failed save/import callback.
  const second = await fixture(t);
  await assert.rejects(second.controller.atStrategyBoundary(async () => { throw Error("save failed"); }), /save failed/);
  await second.controller.atStrategyBoundary(async () => {});
});
