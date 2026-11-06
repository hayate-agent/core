// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ImprovementController } from "../src/improvement.js";
import { nightlyStrategyHolder } from "../src/nightly-strategy.js";
import bundled from "../src/builtin-plugins/nightly-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

for (const example of [
  { identity: undefined, overlay: undefined, accepted: true },
  { identity: undefined, overlay: "custom.mjs", accepted: false },
  { identity: undefined, overlay: null, accepted: false },
  { identity: "custom.mjs", overlay: "custom.mjs", accepted: true },
  { identity: "custom.mjs", overlay: undefined, accepted: false },
  { identity: "custom.mjs", overlay: null, accepted: false },
  { identity: "custom.mjs", overlay: null, accepted: true, adopted: true },
]) test(`startup reconciles pending strategy ${JSON.stringify(example)}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-startup-"));
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  t.after(async () => { await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  await mkdir(path.join(home, "improvement"));
  const file = path.join(home, "improvement/state.json");
  const state = JSON.stringify({ version: 1, night: "2026-10-26", turns: 1, results: ["retained"],
    ...(example.adopted ? { reportQueued: true } : { pending: "original-turn" }), strategySelection: example.identity });
  await writeFile(file, state);
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,prompt(){return 'custom'},completed(){},receipts(){return []},unique(r){return r},report(){return 'custom'}}");
  const holder = await nightlyStrategyHolder(home, undefined, bundled);
  const controller = new ImprovementController(home, harness, "UTC", Date.now, bundled);
  const initialize = controller.initializeStrategy(holder, example.overlay);
  if (example.accepted) await initialize;
  else await assert.rejects(initialize, /Nightly strategy does not match/);
  assert.equal(await readFile(file, "utf8"), state, "startup must not rewrite or discard retained work");
  assert.equal(holder.selection, example.accepted ? example.overlay : undefined);
});

test("new custom night persists selection identity before enqueue and restores it on restart", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-identity-"));
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); harness.paused = true;
  t.after(async () => { await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\ntimezone: UTC\n");
  await writeFile(path.join(home, "custom.mjs"), "export default {apiVersion:1,prompt(){return 'custom'},completed(){},receipts(){return []},unique(r){return r},report(){return 'custom'}}");
  const holder = await nightlyStrategyHolder(home, undefined, bundled);
  const now = () => Date.parse("2026-10-27T23:30:00Z");
  const controller = new ImprovementController(home, harness, "UTC", now, bundled);
  await controller.initializeStrategy(holder, "custom.mjs");
  await controller.tick(true);
  const file = path.join(home, "improvement/state.json");
  assert.equal(JSON.parse(await readFile(file, "utf8")).strategySelection, "custom.mjs");
  const restarted = new ImprovementController(home, harness, "UTC", now, bundled);
  const restored = await nightlyStrategyHolder(home, undefined, bundled);
  await restarted.initializeStrategy(restored, "custom.mjs");
  assert.equal(restored.current!.prompt({} as any, 1), "custom");
});

test("adopted night cannot resume under a replacement if clock returns to its work window", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-closed-"));
  const runtime = new FakeRuntime(), harness = new Harness({ runtime, tickMs: 60000 });
  t.after(async () => { await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  await mkdir(path.join(home, "improvement"));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\ntimezone: UTC\n");
  const file = path.join(home, "improvement/state.json");
  const state = JSON.stringify({ version: 1, night: "2026-10-27", turns: 1, results: [], reportQueued: true });
  await writeFile(file, state);
  const holder = await nightlyStrategyHolder(home, undefined, bundled);
  const controller = new ImprovementController(home, harness, "UTC", () => Date.parse("2026-10-27T23:30:00Z"), bundled);
  await controller.initializeStrategy(holder, undefined);
  await controller.tick(true); await harness.drained();
  assert.equal(runtime.opened.length, 0);
  assert.equal(await readFile(file, "utf8"), state);
});

test("disabled startup creates no night state even in an enabled work window", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-disabled-"));
  const runtime = new FakeRuntime(), harness = new Harness({ runtime, tickMs: 60000 });
  t.after(async () => { await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\ntimezone: UTC\n");
  const holder = await nightlyStrategyHolder(home, undefined, bundled);
  const controller = new ImprovementController(home, harness, "UTC", () => Date.parse("2026-10-27T23:30:00Z"), bundled);
  await controller.initializeStrategy(holder, null);
  await controller.tick(true); await harness.drained();
  await assert.rejects(readFile(path.join(home, "improvement/state.json")), { code: "ENOENT" });
  assert.equal(runtime.opened.length, 0);
});
