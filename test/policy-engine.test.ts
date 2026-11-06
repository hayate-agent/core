// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadPolicyEngine, createPolicyEngine } from "../src/policy-engine.js";
import { PluginHost } from "../src/plugins.js";

const context = { home: "/tmp", cwd: "/tmp", config: {}, backend: { async review() { return ""; } }, notify: async () => {}, origin: () => undefined };
test("local engine supplies policy and tools together without activating bundled default", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "policy-engine-")); t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "custom.mjs"), `export default { apiVersion:1, modelTools:['plugin_custom_review'], create(){return {
    required:['custom'],instructions:'custom selected',policies:[{id:'custom',async beforeTool(){}}],plugins:[{apiVersion:1,activate(api){api.registerTool({name:'plugin_custom_review',description:'custom',parameters:{type:'object'},async execute(){return 'custom'}})}}]
  }}}`);
  let fallback = 0;
  const selected = await loadPolicyEngine(home, "custom.mjs", { apiVersion: 1, modelTools: ["plugin_review"], create() { fallback++; throw Error("not selected"); } });
  const engine = await createPolicyEngine(selected, { ...context, home });
  const host = new PluginHost(); host.policies.require(engine.required); for (const policy of engine.policies) host.policies.register(policy);
  await host.load([], { home, cwd: home, agent: "test" }, [], [], engine.plugins);
  assert.equal(fallback, 0); assert.deepEqual(selected.modelTools, ["plugin_custom_review"]);
  assert.ok(host.tools.has("plugin_custom_review")); assert.equal(host.tools.has("plugin_review"), false);
  assert.equal(host.policies.has("review"), false); assert.throws(() => host.policies.remove("custom"), /Required/);
  await host.stop();
});
test("invalid module or missing required composition fails rather than falling back", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "policy-invalid-")); t.after(() => rm(home, { recursive: true, force: true }));
  const baseline = { apiVersion: 1 as const, modelTools: [], create() { return { policies: [], required: [], plugins: [], instructions: "" }; } };
  await writeFile(path.join(home, "bad.mjs"), 'export default {apiVersion:2,modelTools:[],create(){}}');
  await assert.rejects(loadPolicyEngine(home, "bad.mjs", baseline), /Invalid/);
  await assert.rejects(loadPolicyEngine(home, "missing.mjs", baseline));
  await assert.rejects(createPolicyEngine({ ...baseline, create() { return { policies: [], required: ["absent"], plugins: [], instructions: "" }; } }, context), /Invalid/);
  assert.deepEqual(await createPolicyEngine(await loadPolicyEngine(home, undefined, baseline), context), { policies: [], required: [], plugins: [], instructions: "" });
});
