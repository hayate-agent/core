import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Cron } from "croner";
import { ImprovementController, improvementPolicy } from "../src/improvement.js";
import { Harness } from "../src/harness.js";
import bundled from "../src/builtin-plugins/nightly-default.js";
import { FakeRuntime } from "./fakes.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "night-catchup-"));
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  let now = Date.parse("2026-10-31T21:00:00Z");
  const policy = improvementPolicy({ timezone: "Europe/Berlin", maxTurns: 2 });
  const controller = new ImprovementController(home, harness, "UTC", () => now, bundled);
  controller.policy = async () => policy;
  await controller.start(); // outside window: startup cannot hide a broken periodic callback
  const jobs = (controller as unknown as { cronJobs: Cron[] }).cronJobs;
  t.after(async () => { controller.stop(); await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  const stateFile = path.join(home, "improvement", "state.json");
  return { home, harness, controller, jobs, policy, setNow: (value: string) => { now = Date.parse(value); },
    state: async () => JSON.parse(await readFile(stateFile, "utf8")),
    seed: async (state: object) => { await mkdir(path.dirname(stateFile), { recursive: true }); await writeFile(stateFile, JSON.stringify(state)); } };
}

test("overlapping periodic/start callbacks recover the missed night on the next periodic tick", async t => {
  const f = await fixture(t);
  await f.seed({ version: 1, night: "2026-10-30", turns: 2, results: [], reportQueued: true });
  f.setNow("2026-10-31T22:00:00Z");
  const original = f.controller.policy.bind(f.controller);
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.controller.policy = async () => { entered(); await held; return original(); };
  // Exactly the historical race: a state-only tick holds checking across policy IO.
  const periodicInFlight = f.controller.tick(false);
  await ready;
  await f.jobs[0].trigger();
  release(); await periodicInFlight;
  assert.equal((await f.state()).night, "2026-10-30");
  f.controller.policy = original;
  await f.jobs[2].trigger();
  assert.equal((await f.state()).night, "2026-10-31");
  assert.equal((await f.state()).pending, "improvement:2026-10-31:1");
  await f.jobs[2].trigger();
  assert.equal((await f.state()).night, "2026-10-31");
  assert.equal((await f.state()).turns, 0);
  assert.equal((await f.state()).pending, "improvement:2026-10-31:1");
});

test("periodic catchup retains pause/busy intent and restart budget", async t => {
  const f = await fixture(t);
  f.setNow("2026-10-31T22:05:00Z");
  f.harness.paused = true;
  await f.jobs[2].trigger();
  assert.equal((await f.state()).night, "2026-10-31");
  assert.equal((await f.state()).pending, undefined);
  f.harness.paused = false;
  f.harness.enqueue({ id: "interactive", sessionKey: "interactive", source: "cron", text: "held" });
  const session = f.harness.sessions.get("interactive")!;
  session.running = true;
  await f.jobs[2].trigger();
  assert.equal((await f.state()).pending, undefined);
  session.running = false;
  session.queue.length = 0;
  await f.jobs[2].trigger();
  assert.equal((await f.state()).pending, "improvement:2026-10-31:1");
  // Persist an exhausted night, then instantiate a fresh controller like process restart.
  await f.seed({ version: 1, night: "2026-10-31", turns: 2, results: [] });
  const restarted = new ImprovementController(f.home, f.harness, "UTC", () => Date.parse("2026-11-01T00:00:00Z"), bundled);
  restarted.policy = async () => f.policy;
  f.harness.sessions.get("improvement:nightly")!.queue.length = 0;
  await restarted.start();
  t.after(async () => restarted.stop());
  await (restarted as unknown as { cronJobs: Cron[] }).cronJobs[2].trigger();
  assert.equal((await f.state()).turns, 2);
  assert.equal((await f.state()).pending, undefined);
});

test("periodic catchup cannot start outside window, disabled policy or disabled/changing strategy", async t => {
  const f = await fixture(t);
  for (const time of ["2026-10-31T21:55:00Z", "2026-11-01T04:00:00Z"]) {
    f.setNow(time); await f.jobs[2].trigger();
    await assert.rejects(f.state(), { code: "ENOENT" });
  }
  f.setNow("2026-10-31T22:05:00Z");
  f.policy.enabled = false;
  await f.jobs[2].trigger();
  await assert.rejects(f.state(), { code: "ENOENT" });
  f.policy.enabled = true;
  await f.controller.atStrategyBoundary(async () => {
    await f.jobs[2].trigger();
    await assert.rejects(f.state(), { code: "ENOENT" });
  });
  const disabled = new ImprovementController(f.home, f.harness, "UTC", () => Date.parse("2026-10-31T22:05:00Z"));
  disabled.policy = async () => f.policy;
  await disabled.start();
  t.after(async () => disabled.stop());
  await (disabled as unknown as { cronJobs: Cron[] }).cronJobs[2].trigger();
  await assert.rejects(f.state(), { code: "ENOENT" });
});

test("scheduler errors are classified without sensitive messages and rate limited, then recover", async t => {
  const f = await fixture(t);
  f.setNow("2026-10-31T22:05:00Z");
  const logs: string[] = [];
  t.mock.method(console, "error", (message: string) => logs.push(message));
  f.controller.policy = async () => { throw new SyntaxError("SECRET policy contents\nstack"); };
  await f.jobs[2].trigger(); await f.jobs[0].trigger();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /scheduled tick failed \(syntax\)/);
  assert.doesNotMatch(logs[0], /SECRET|stack/);
  f.setNow("2026-10-31T22:10:00Z");
  await f.jobs[2].trigger(); assert.equal(logs.length, 2);
  f.controller.policy = async () => f.policy;
  await f.jobs[2].trigger();
  assert.equal((await f.state()).pending, "improvement:2026-10-31:1");
});
