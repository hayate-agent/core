import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController, improvementPolicy, improvementWindow } from "../src/improvement.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, ROOM } from "./fakes.js";

test("improvement defaults off with 20 turns; overnight date and DST use local calendar", () => {
  assert.equal(improvementPolicy().enabled, false);
  assert.equal(improvementPolicy().maxTurns, 20);
  assert.throws(() => improvementPolicy({ maxTurns: 0 }));
  assert.throws(() => improvementPolicy({ merge: true }));
  assert.throws(() => improvementPolicy({ timezone: "invalid" }));
  const p = improvementPolicy({ timezone: "Europe/Berlin" });
  assert.deepEqual(improvementWindow(Date.parse("2026-10-24T22:00:00Z"), p), { night: "2026-10-24", active: true });
  assert.deepEqual(improvementWindow(Date.parse("2026-10-25T02:30:00Z"), p), { night: "2026-10-24", active: true });
  assert.equal(improvementWindow(Date.parse("2026-10-25T04:00:00Z"), p).active, false);
});
test("startup catches up missed Cron only within the enabled night window and preserves budget", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "improvement-catchup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 1\ntimezone: Europe/Berlin\n");
  let now = Date.parse("2026-10-24T21:42:00Z");
  const harness = new Harness({ runtime: new FakeRuntime(() => "measured checkpoint"), tickMs: 60000 });
  const channel = new MemoryChannel(); harness.addChannel(channel); harness.home = ROOM;
  let controller = new ImprovementController(home, harness, "Europe/Berlin", () => now);
  const opts = (harness as any).opts;
  opts.beforeTurn = (input: any) => controller.before(input);
  opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
  try {
    await controller.start(); await harness.drained(); controller.stop();
    assert.equal(harness.sessions.get("improvement:nightly")?.session?.status().messages, 2);
    controller = new ImprovementController(home, harness, "Europe/Berlin", () => now);
    await controller.start(); await harness.drained(); controller.stop();
    assert.equal(harness.sessions.get("improvement:nightly")?.session?.status().messages, 2, "restart cannot reset budget");
    now = Date.parse("2026-10-25T04:00:00Z"); // 05:00 CET after DST change
    controller = new ImprovementController(home, harness, "Europe/Berlin", () => now);
    await controller.start(); await harness.drained(); controller.stop();
    assert.equal(harness.sessions.get("improvement:nightly")?.session?.status().messages, 2);
    assert.equal(channel.texts().filter((s) => s.startsWith("Nachtbericht")).length, 1);
  } finally { controller.stop(); await harness.stop(1000); }
});

test("persistent improvement budget, early completion and unsolicited morning report", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "improvement-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 2\ntimezone: UTC\n");
  let now = Date.parse("2026-10-24T23:00:00Z");
  const harness = new Harness({ runtime: new FakeRuntime(() => "Test baseline verified"), tickMs: 60000 });
  const channel = new MemoryChannel(); harness.addChannel(channel); harness.home = ROOM;
  let controller = new ImprovementController(home, harness, "UTC", () => now);
  // Exercise the same hooks as CLI.
  const opts = (harness as any).opts;
  opts.beforeTurn = (input: any) => controller.before(input);
  opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
  harness.state("mem:interactive").running = true;
  await controller.tick(true);
  assert.equal(harness.sessions.has("improvement:nightly"), false);
  harness.state("mem:interactive").running = false;
  controller = new ImprovementController(home, harness, "UTC", () => now);
  await controller.tick(false); await harness.drained();
  assert.equal(harness.sessions.get("improvement:nightly")?.session?.status().messages, 2);
  controller = new ImprovementController(home, harness, "UTC", () => now);
  await controller.tick(); await harness.drained();
  await controller.tick(); await harness.drained();
  assert.equal(harness.sessions.get("improvement:nightly")?.session?.status().messages, 4);
  now = Date.parse("2026-10-25T05:00:00Z");
  await controller.tick(); await harness.drained();
  assert.equal(channel.texts().filter((x) => x.startsWith("Nachtbericht")).length, 1);
  await controller.tick(); await harness.drained();
  assert.equal(channel.texts().filter((x) => x.startsWith("Nachtbericht")).length, 1);
  // Skip a morning report: an old report adopted at the next Cron start must
  // not consume that next night's start intent, including across restart.
  now = Date.parse("2026-10-25T23:00:00Z");
  await controller.tick(true); await harness.drained();
  now = Date.parse("2026-10-26T23:00:00Z");
  await controller.tick(true); await harness.drained();
  controller = new ImprovementController(home, harness, "UTC", () => now);
  await controller.tick(false); await harness.drained();
  const state = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(home, "improvement", "state.json"), "utf8"));
  assert.equal(state.night, "2026-10-26");
  assert.equal(state.turns, 1);
  await harness.stop(1000);
});
