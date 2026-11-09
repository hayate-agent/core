import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController } from "./improvement-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

for (const policy of [undefined, "maxTurns: 1\n", "enabled: false\n"]) {
  test(`default enablement with ${policy === undefined ? "missing file" : JSON.stringify(policy)}`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "improvement-default-"));
    let now = Date.parse("2026-10-24T20:59:00Z"), calls = 0;
    const harness = new Harness({ runtime: new FakeRuntime(() => {
      calls++; return "No new experiment; stop safely [IMPROVEMENT_DONE]";
    }), tickMs: 60000, log: () => {} });
    const channel = new MemoryChannel(); harness.addChannel(channel);
    // No home/reportTo: even with a registered channel, never broadcast.
    let controller = new ImprovementController(home, harness, "Europe/Berlin", () => now);
    t.after(async () => { controller.stop(); await harness.stop(0); await rm(home, { recursive: true, force: true }); });
    if (policy !== undefined) await writeFile(path.join(home, "improvement.yaml"), policy);
    const p = await controller.policy();
    assert.equal(p.enabled, policy !== "enabled: false\n");
    assert.equal(p.timezone, "Europe/Berlin");
    assert.equal(p.maxTurns, policy === "maxTurns: 1\n" ? 1 : 20);
    assert.equal(p.pullRequest, undefined); assert.equal(p.merge, undefined);
    assert.equal(p.evaluator, undefined); assert.equal(p.reportTo, undefined);
    const opts = (harness as any).opts;
    opts.beforeTurn = (input: any) => controller.before(input);
    opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
    await controller.tick(); await harness.drained();
    assert.equal(calls, 0, "outside local night window");
    now = Date.parse("2026-10-24T21:00:00Z"); // 23:00 Berlin
    for (let i = 0; i < 25; i++) { await controller.tick(); await harness.drained(); }
    if (!p.enabled) {
      assert.equal(calls, 0, "explicit false remains an opt-out");
      await assert.rejects(readFile(path.join(home, "improvement/state.json")), { code: "ENOENT" });
    } else {
      assert.equal(calls, Math.min(p.maxTurns, 3), "budget and no-experiment stop remain enforced");
      const statePath = path.join(home, "improvement/state.json");
      const before = JSON.parse(await readFile(statePath, "utf8"));
      assert.equal(before.turns, calls);
      controller = new ImprovementController(home, harness, "Europe/Berlin", () => now);
      await controller.tick(); await harness.drained();
      assert.equal(calls, before.turns, "controller restart cannot reset the night");
      now = Date.parse("2026-10-25T04:00:00Z"); // 05:00 Berlin after DST
      await controller.tick(); await harness.drained();
      const report = JSON.parse(await readFile(path.join(home, "improvement/reports/2026-10-24.json"), "utf8"));
      assert.equal(report.delivery, "local-only");
      assert.equal(report.timezone, "Europe/Berlin");
      assert.deepEqual(report.experiments, [], "no fabricated receipts or evaluator");
      await assert.rejects(controller.evaluate({} as any), /outside configured improvement session\/window/);
    }
    assert.equal(channel.texts().length, 0, "no implicit broadcast");
  });
}
