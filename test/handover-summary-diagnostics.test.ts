import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import type { RuntimeSession } from "../src/types.js";

for (const scenario of ["generated", "invalid", "failed", "unavailable"] as const) {
  test(`handover records safe summary diagnostic: ${scenario}`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "summary-diag-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const summarize = scenario === "unavailable" ? undefined : async () => {
      if (scenario === "failed") throw Error("private provider detail");
      return scenario === "invalid" ? " " : "CURRENT STATE AND NEXT STEPS\nCheck the work";
    };
    const m = new ContextMaintenance(home, () => contextPolicy(), undefined, Date.now, summarize);
    const source = { status: () => ({ sessionId: "old" }), archiveEntries: () => [] } as unknown as RuntimeSession;
    await m.request("mem:room1", { action: "handover", preserve: "state", resume: "continue" });
    let status: unknown;
    await m.beforeTurn("mem:room1", source, async handover => {
      status = handover?.summaryStatus;
      return { status: () => ({ sessionId: "new" }) } as RuntimeSession;
    });
    assert.equal(status, scenario);
    const state = await m.status("mem:room1");
    assert.equal(state.handover?.summaryStatus, scenario);
    assert.doesNotMatch(JSON.stringify(state), /private provider detail/);
  });
}
