import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contextStrategies, contextStrategyHolder, disabledContextStrategies, diagnosedBoundaryAssessor } from "../src/context-strategies.js";
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

test("async context generation prepares pair before save; invalid factory or save failure retains it", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-pair-")); t.after(() => rm(home, { recursive: true, force: true }));
  const initial = { apiVersion: 1 as const, create: async () => ({ assess: async () => "keep" as const, project: (messages: any[]) => messages }) };
  const holder = await contextStrategyHolder(home, undefined, initial, context, undefined);
  const pinned = holder.current!;
  await writeFile(path.join(home, "custom.mjs"), `export default {apiVersion:1,async create(){await Promise.resolve();return {label:'handover',async assess(){return this.label},project(m){if(this.label!=='handover')throw Error('receiver');return m.slice()}}}}`);
  const evidence = { phase: "before" as const, incoming: "", recent: "", pressureSinceCompaction: false };
  await holder.change("custom.mjs", async () => { assert.equal(holder.current, pinned); });
  assert.equal(await holder.current!.assess(evidence), "handover");
  assert.equal(await pinned.assess(evidence), "keep");
  const messages = [{ role: "toolResult", content: [] }];
  assert.notEqual(holder.current!.project(messages, pruningPolicy()), messages);
  const active = holder.current;
  await writeFile(path.join(home, "bad.mjs"), "export default {apiVersion:1,async create(){return {assess(){}}}}");
  await assert.rejects(holder.change("bad.mjs", async () => {}), /Invalid context strategies/);
  await assert.rejects(holder.change(null, async () => { throw Error("save failed"); }), /save failed/);
  assert.equal(holder.current, active);
  await holder.change(null, async () => {});
  assert.equal(holder.current, undefined);
  assert.equal(await disabledContextStrategies.assess(evidence), "unknown");
  assert.equal(disabledContextStrategies.project(messages, pruningPolicy()), messages);
  await holder.change(undefined, async () => {});
  assert.equal(await holder.current!.assess(evidence), "keep");
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
