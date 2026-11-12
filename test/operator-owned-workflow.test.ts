import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig } from "../src/config.js";
import { initialize } from "../src/setup.js";
import { createReviewEngine } from "../src/builtin-plugins/review-engine.js";
import { improvementPolicy } from "../src/improvement.js";
import { improvementPrompt } from "../src/builtin-plugins/nightly-default.js";
import { reviewConfig } from "../src/review-config.js";

const backend = { async review() { throw Error("Unconfigured review must not run"); } };
const forbidden = /Do not merge|own PRs|own pull requests|GitOps|P0\/P1 block publication|Übernahme\/Merge sind dann verboten|nach Tests\/Review/i;

test("fresh initialization creates no implicit review gates or repository workflow", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "operator-owned-workflow-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await initialize({ home, cwd: home, agent: "Test" });
  const config = await loadConfig(home);
  assert.deepEqual(config.review, defaultConfig({ home }).review);
  assert.equal(config.review.enabled, false);
  assert.deepEqual(config.review.mandatory, { local: false, publish: false, merge: false });
  const engine = createReviewEngine({ home, cwd: home, config: config.review, backend,
    async notify() {}, origin: () => undefined });
  assert.deepEqual(engine.policies, []);
  assert.deepEqual(engine.plugins, []);
  assert.deepEqual(engine.required, []);
  assert.equal(engine.instructions, "");
  for (const file of ["SOUL.md", "hayate-agent.yaml"]) assert.doesNotMatch(await readFile(path.join(home, file), "utf8"), forbidden);
});

test("enabling review alone is advisory, configured gates remain exact", () => {
  const config = reviewConfig({ enabled: true, mandatory: { merge: true } });
  const engine = createReviewEngine({ home: "/tmp", cwd: "/tmp", config, backend,
    async notify() {}, origin: () => undefined });
  assert.match(engine.instructions, /"mandatory":\{"local":false,"publish":false,"merge":true\}/);
  assert.doesNotMatch(engine.instructions, forbidden);
});

test("nightly strategy does not invent merge bans, GitOps or compulsory review", () => {
  const prompt = improvementPrompt(improvementPolicy(), 1);
  assert.doesNotMatch(prompt, forbidden);
  assert.doesNotMatch(prompt, /Operator-Konfiguration (PR-Erstellung|Merge)/);
  assert.match(improvementPrompt(improvementPolicy({ pullRequest: false, merge: false }), 1), /Operator-Konfiguration Merge: nicht erlaubt/);
  assert.match(improvementPrompt(improvementPolicy({ pullRequest: true, merge: true }), 1), /Operator-Konfiguration Merge: erlaubt/);
});
