import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contextStrategies, diagnosedBoundaryAssessor } from "../src/context-strategies.js";
import { boundaryAssessor } from "../src/builtin-plugins/boundary-assessor.js";
import { pruningPolicy } from "../src/tool-result-pruning.js";

const context = { backend: { async review() { throw Error("must not call bundled model"); } }, model: () => undefined };
const baseline = { apiVersion: 1 as const, create() { throw Error("must not create bundled strategy"); } };
test("startup custom context strategy replaces assessment and projection together with receiver retained", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-strategy-")); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "strategy.mjs"), `export default {apiVersion:1,create(){return {choice:'keep',async assess(){return this.choice},project(messages){if(this.choice!=='keep')throw Error('receiver');return messages}}}}`);
  const selected = await contextStrategies(home, "strategy.mjs", baseline, context);
  assert.equal(await selected.assess({ phase: "after", incoming: "", recent: "", pressureSinceCompaction: false }), "keep");
  const messages = [{ role: "toolResult", content: [{ type: "text", text: "unchanged" }] }];
  assert.equal(selected.project(messages, pruningPolicy()), messages);
});
test("missing or malformed strategy fails rather than silently loading bundled behavior", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-invalid-")); t.after(() => rm(home, { recursive: true, force: true }));
  await assert.rejects(contextStrategies(home, "missing.mjs", baseline, context));
  await writeFile(path.join(home, "bad.mjs"), 'export default {apiVersion:1,create(){return {assess(){}}}}');
  await assert.rejects(contextStrategies(home, "bad.mjs", baseline, context), /Invalid context strategies/);
  const selected = await contextStrategies(home, undefined, { apiVersion: 1, create: () => ({ assess: async () => "unknown", project: messages => messages }) }, context);
  assert.equal(await selected.assess({ phase: "before", incoming: "", recent: "", pressureSinceCompaction: false }), "unknown");
});

for (const outcome of ["failed", "timeout", "malformed", "keep"] as const) test(`bundled assessor ${outcome} remains advisory with safe diagnostics`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const assess = diagnosedBoundaryAssessor({ review: async () => {
    if (outcome === "failed") throw Error("secret provider token");
    if (outcome === "timeout") return new Promise<string>(() => {});
    return outcome === "malformed" ? "not json" : '{"action":"keep"}';
  } }, () => undefined, boundaryAssessor);
  const pending = assess({ phase: "before", incoming: "", recent: "", pressureSinceCompaction: false });
  if (outcome === "timeout") t.mock.timers.tick(10000);
  if (outcome === "failed" || outcome === "timeout") await assert.rejects(pending, (err: any) => err.stage === "assessment" && err.code === outcome && !err.message.includes("secret"));
  else assert.equal(await pending, outcome === "keep" ? "keep" : "unknown");
});
