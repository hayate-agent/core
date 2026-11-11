import assert from "node:assert/strict";
import test from "node:test";
import { assessCompletion } from "./completion-default.js";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { FakeSession, msg } from "./fakes.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

for (const action of ["compact", "handover", "invented", null]) test(`classifier validates context preparation ${action}`, async () => {
  const result = await assessCompletion({ review: async () => JSON.stringify({ state: "continue", next: "Run regression", contextPreparation: action }) },
    msg("Run regression"), "Context exhausted", { task: "Run regression" }, new AbortController().signal);
  if (action === "compact" || action === "handover") assert.equal(result?.contextPreparation, action);
  else assert.equal(result, undefined);
});
for (const policy of [{ enabled: false }, { autoHandover: false }]) test(`required preparation respects policy ${JSON.stringify(policy)}`, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "semantic-policy-"));
  const maintenance = new ContextMaintenance(home, () => contextPolicy(policy));
  const session = new FakeSession("chat", () => "unused");
  try {
    await maintenance.prepareContinuation("chat", session, async () => {
      throw Error("must not rotate");
    }, "handover", "No deployment", "Run regression");
    const held = await maintenance.recoveryStatus("chat");
    assert.equal(held?.state, "blocked"); assert.equal(held?.reason, "policy");
    assert.equal(held?.failedAttempts, 0, "no runtime attempt took place");
    assert.equal(session.compacted, 0);
    assert.equal((await maintenance.status("chat")).pending?.preserve, "No deployment");
  } finally { await rm(home, { recursive: true, force: true }); }
});
