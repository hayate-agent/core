// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nightlyStrategy, nightlyStrategyHolder } from "../src/nightly-strategy.js";
import bundled from "../src/builtin-plugins/nightly-default.js";
import { ImprovementController } from "../src/improvement.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

test("custom nightly strategy selects prompt, conclusions and report without changing host reservation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-selection-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "custom.mjs"), `export default {apiVersion:1,label:'custom',prompt(){return this.label},completed(state){state.turns=0;state.pending='forged';state.done=true},receipts(){return []},unique(r){return r},report(){return this.label+' report'}}`);
  const strategy = await nightlyStrategy(home, "custom.mjs", bundled);
  assert.equal(strategy.prompt({} as any, 1), "custom");
  const runtime = new FakeRuntime(() => "result");
  const harness = new Harness({ runtime, tickMs: 60000 });
  t.after(() => harness.stop(0));
  const now = Date.parse("2026-10-24T23:00:00Z");
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 1\ntimezone: UTC\n");
  const controller = new ImprovementController(home, harness, "UTC", () => now, strategy);
  (harness as any).opts.beforeTurn = (input: any) => controller.before(input);
  (harness as any).opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
  await controller.tick(true); await harness.drained();
  const state = JSON.parse(await readFile(path.join(home, "improvement/state.json"), "utf8"));
  assert.equal(state.turns, 1); assert.equal(state.pending, undefined); assert.equal(state.done, true);
  assert.ok(runtime.sessions.get("improvement:nightly")!.prompts[0].startsWith("custom"));
});
test("holder binds all five methods, pins generations and retains selection on invalid replacement", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-holder-")); t.after(() => rm(home, { recursive: true, force: true }));
  const module = (label: string) => `export default {apiVersion:1,label:${JSON.stringify(label)},prompt(){return this.label},completed(s){s.results=[this.label]},receipts(){return [{label:this.label}]},unique(r){return r.filter(x=>x.label===this.label)},report(){return this.label}}`;
  await writeFile(path.join(home, "custom.mjs"), module("custom"));
  const holder = await nightlyStrategyHolder(home, undefined, bundled);
  await holder.change("custom.mjs", async () => {});
  const pinned = holder.current!;
  assert.equal(pinned.prompt({} as any, 1), "custom");
  const progress = { results: [] } as any; pinned.completed(progress, "reply"); assert.deepEqual(progress.results, ["custom"]);
  assert.deepEqual(pinned.receipts("reply"), [{ label: "custom" }]);
  assert.deepEqual(pinned.unique([{ label: "custom" }, { label: "other" }] as any), [{ label: "custom" }]);
  assert.equal(pinned.report({ night: "test", turns: 1 }, "UTC", [], "artifact"), "custom");
  await writeFile(path.join(home, "custom.mjs"), module("new"));
  await holder.change("custom.mjs", async () => {});
  assert.equal(holder.current!.prompt({} as any, 1), "new");
  assert.equal(pinned.prompt({} as any, 1), "custom");
  await writeFile(path.join(home, "bad.mjs"), "export default {apiVersion:1,prompt(){}}");
  await assert.rejects(holder.change("bad.mjs", async () => {}), /Invalid nightly strategy/);
  assert.equal(holder.current!.prompt({} as any, 1), "new");
});

test("nightly selection fails on invalid module instead of silently using default", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-invalid-")); t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(nightlyStrategy(home, "missing.mjs", bundled));
  await writeFile(path.join(home, "bad.mjs"), "export default {apiVersion:1,prompt(){}}");
  await assert.rejects(nightlyStrategy(home, "bad.mjs", bundled), /Invalid nightly strategy/);
  assert.equal((await nightlyStrategy(home, undefined, bundled)).apiVersion, 1);
});
