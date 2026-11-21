import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController } from "../src/improvement.js";
import nightlyDefault from "../src/builtin-plugins/nightly-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import type { Execution } from "../src/execution.js";

for (const status of ["paused", "blocked", "ready", "running"] as const) {
  test(`nightly scheduler respects ${status} delegation without silently abandoning the night`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "nightly-held-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 2\ntimezone: UTC\n");
    const replies: string[] = [];
    const harness = new Harness({ runtime: new FakeRuntime(() => { replies.push("NO_REPLY"); return "NO_REPLY"; }), tickMs: 60000 });
    const child = { id: "held-child", parent: "improvement:nightly", status,
      dependency: { taskId: "improvement:2026-11-20:1" } } as Execution;
    const controller = new ImprovementController(home, harness, "UTC", () => Date.parse("2026-11-21T00:00:00Z"), nightlyDefault, undefined, () => [child]);
    const opts = (harness as any).opts;
    opts.beforeTurn = (input: any) => controller.before(input);
    opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
    try {
      await controller.start(); await harness.drained(); controller.stop();
      // First admission creates the night; subsequent ticks must respect its owner.
      await controller.start(); await harness.drained(); controller.stop();
      if (status === "ready" || status === "running") assert.equal(replies.length, 1, "productive owner is not duplicated");
      else {
        assert.equal(replies.length, 2, "inactive child cannot suppress the next nightly turn");
        assert.equal(child.status, status, "the child hold must not be cleared");
      }
    } finally { controller.stop(); await harness.stop(); }
  });
}
