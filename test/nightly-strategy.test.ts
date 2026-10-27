import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nightlyStrategy } from "../src/nightly-strategy.js";
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
test("nightly selection fails on invalid module instead of silently using default", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-invalid-")); t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(nightlyStrategy(home, "missing.mjs", bundled));
  await writeFile(path.join(home, "bad.mjs"), "export default {apiVersion:1,prompt(){}}");
  await assert.rejects(nightlyStrategy(home, "bad.mjs", bundled), /Invalid nightly strategy/);
  assert.equal((await nightlyStrategy(home, undefined, bundled)).apiVersion, 1);
});
