import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { SettingsService } from "../src/settings.js";
import { pickModelRule } from "../src/dispatcher-config.js";
import { pruningPolicy } from "../src/tool-result-pruning.js";

test("tolerant startup/reload, safe routing, recovery, durable restart and provenance", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "overlay-tolerant-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.local.yaml");
  const warnings: string[] = [];
  const base = { model: "p/base", dispatcher: { rules: [{ model: "p/base" }] }, reasoningEffortNoneModels: ["p/base"] };
  const settings = new SettingsService(file, base, m => warnings.push(m));
  const rules = [{ match: { keywords: ["safe"] }, model: "p/safe" }, { model: "p/fallback" }];
  await writeFile(file, stringify({ model: "p/local", thinking: 42, admins: ["DO_NOT_LOG_SECRET"], unknown: true,
    dispatcher: { rules, capacity: 2, unknown: true }, reasoningEffortNoneModels: ["p/good", 42], skills: { context: "lazy", paths: 42 } }));
  await settings.load();
  assert.equal(settings.effective().model, "p/local");
  assert.equal(settings.source("model"), "local overlay");
  assert.equal(settings.effective().thinking, undefined);
  assert.equal(settings.effective().skills?.context, "lazy");
  assert.deepEqual(settings.effective().reasoningEffortNoneModels, ["p/good"]);
  assert.deepEqual(settings.effective().dispatcher?.rules, rules);
  assert.equal(settings.effective().dispatcher?.capacity, 2);
  assert.ok(warnings.length && settings.diagnostics.length <= 20);
  assert.ok(!warnings.join().includes("DO_NOT_LOG_SECRET"));
  const lastGood = settings.effective();
  await writeFile(file, stringify({ model: "p/forbidden-live", dispatcher: { capacity: 3, rules: [] }, reasoningEffortNoneModels: ["p/new", false], approvals: {} }));
  await settings.reload();
  assert.equal(settings.effective().model, "p/local");
  assert.equal(settings.effective().dispatcher?.capacity, 2);
  assert.deepEqual(settings.effective(), lastGood);
  for (const match of [{ regex: "[" }, { minChars: "bad" }, { unknown: 1 }]) {
    await writeFile(file, stringify({ dispatcher: { rules: [{ match, model: "p/unsafe" }, { model: "p/fallback" }] }, reasoningEffortNoneModels: ["p/valid"] }));
    await settings.reload();
    assert.deepEqual(settings.effective(), lastGood, "invalid file retains all previous settings");
  }
  for (const text of ["[broken", "42", "null", "[]"]) {
    await writeFile(file, text);
    await settings.reload();
    assert.deepEqual(settings.effective(), lastGood);
    const fresh = new SettingsService(file, base); await fresh.load();
    assert.deepEqual(fresh.effective().reasoningEffortNoneModels, ["p/base"]);
  }
  for (const badRule of [{ model: "invalid" }, { model: "p/good", thinking: "invalid" }]) {
    await writeFile(file, stringify({ dispatcher: { rules: [badRule, { model: "p/fallback" }] }, reasoningEffortNoneModels: ["p/recovered"] }));
    await settings.reload();
    assert.deepEqual(settings.effective(), lastGood);
    const startup = new SettingsService(file, base); await startup.load();
    assert.deepEqual(startup.effective().dispatcher?.rules, base.dispatcher.rules);
    assert.deepEqual(startup.effective().reasoningEffortNoneModels, ["p/recovered"]);
  }
  await writeFile(file, stringify({ dispatcher: { rules }, reasoningEffortNoneModels: [] }));
  await settings.reload();
  assert.deepEqual(settings.effective().dispatcher?.rules, rules);
  assert.deepEqual(settings.effective().reasoningEffortNoneModels, []);
  await settings.set("thinking", "off");
  const fresh = new SettingsService(file, base); await fresh.load();
  assert.deepEqual(fresh.effective(), settings.effective());
  assert.equal(fresh.effective().model, "p/base");
  await writeFile(file, "{}"); await settings.reload();
  assert.deepEqual(settings.effective().dispatcher?.rules, base.dispatcher.rules);
  assert.deepEqual(settings.effective().reasoningEffortNoneModels, ["p/base"]);
  assert.equal(settings.effective().model, "p/base", "removal restores installation defaults");
});

test("startup cross-field safety and valid coupled values survive invalid siblings", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "overlay-coupled-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.local.yaml");
  await writeFile(file, stringify({ dispatcher: { enabled: true, concurrentRequests: true, capacity: "bad" }, model: "p/ok" }));
  const settings = new SettingsService(file, {}); await settings.load();
  assert.equal(settings.effective().dispatcher?.enabled, true);
  assert.equal(settings.effective().dispatcher?.concurrentRequests, true);
  assert.equal(settings.effective().dispatcher?.capacity, 4);
  await writeFile(file, stringify({ dispatcher: { enabled: true }, model: "p/ok" }));
  const unsafe = new SettingsService(file, {}); await unsafe.load();
  assert.equal(unsafe.effective().dispatcher?.enabled, false);
  assert.equal(unsafe.effective().model, "p/ok");
  await writeFile(file, stringify({ toolResultPruning: { minResultChars: 300, maxResultChars: 500, keepRecent: 2 },
    ...Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`unknown${i}`, "DO_NOT_LOG_SECRET"])) }));
  const bounded: string[] = [];
  const pruning = new SettingsService(file, {}, m => bounded.push(m)); await pruning.load();
  assert.equal(pruning.effective().toolResultPruning?.keepRecent, 2);
  const policy = pruningPolicy(pruning.effective().toolResultPruning);
  assert.ok(policy.minResultChars > policy.maxResultChars);
  assert.equal(bounded.length, 20);
  assert.ok(bounded.every(m => m.length <= 240 && !m.includes("DO_NOT_LOG_SECRET")));
});
