import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { SettingsService } from "../src/settings.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "settings-dropins-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "settings.d"));
  return { home, file: path.join(home, "settings.local.yaml"), drop: (name: string) => path.join(home, "settings.d", name) };
}
for (const count of [1, 50]) test(`${count} direct layers use lexical order, not insertion order`, async t => {
  const { file, drop } = await fixture(t);
  await writeFile(file, "model: p/local\n");
  for (let i = count; i > 0; i--) await writeFile(drop(`${String(i).padStart(3, "0")}.${i % 2 ? "yaml" : "yml"}`), `model: p/m${i}\n`);
  await writeFile(drop("ignored.txt"), "invalid: true");
  await mkdir(drop("nested")); await writeFile(path.join(drop("nested"), "x.yaml"), "model: p/nested");
  const settings = new SettingsService(file, { model: "p/base" }); await settings.load();
  assert.equal(settings.effective().model, `p/m${count}`);
});

test("category merge preserves maps and replaces arrays; all allowlisted categories load", async t => {
  const { file, drop } = await fixture(t);
  const baseline = {
    model: "p/base", thinking: "off", review: { model: "p/review", thinking: "low" },
    reasoningEffortNoneModels: ["p/base"], dispatcher: { rules: [{ match: {}, model: "p/base" }] },
    skills: { paths: ["a"], context: "auto" }, memory: { enabled: false },
    gatewayPlugins: { sample: { module: "old.mjs" } },
  } as const;
  await writeFile(file, stringify(baseline));
  await writeFile(drop("a.yaml"), stringify({
    review: { thinking: "high" }, reasoningEffortNoneModels: ["p/new"],
    dispatcher: { rules: [{ match: {}, model: "p/new" }] },
    skills: { paths: ["b"], context: "lazy" }, memory: { enabled: true },
    gatewayPlugins: { sample: { disabled: true } }, policyPlugins: { custom: { module: "policy.mjs" } },
    extensionPlugins: { custom: { module: "extension.mjs" } },
    completionStrategy: null, nightlyStrategy: "night.mjs", contextStrategy: "context.mjs", compactionStrategy: "native",
    contextMaintenance: { enabled: false }, toolResultPruning: { enabled: false }, gateways: {},
  }));
  const settings = new SettingsService(file, {}); await settings.load();
  assert.deepEqual(settings.diagnostics, []);
  const effective = settings.effective();
  assert.deepEqual(effective.review, { model: "p/review", thinking: "high" });
  assert.deepEqual(effective.skills, { paths: ["b"], context: "lazy" });
  assert.deepEqual(effective.reasoningEffortNoneModels, ["p/new"]);
  assert.deepEqual(effective.dispatcher?.rules, [{ match: {}, model: "p/new" }]);
  assert.deepEqual(effective.gatewayPlugins?.sample, { module: "old.mjs", disabled: true });
  assert.equal(effective.extensionPlugins?.custom.module, "extension.mjs");
  assert.equal(effective.memory?.enabled, true);
  assert.equal(effective.completionStrategy, null);
});

test("reload add/edit/delete recomputes baseline; invalid any layer rolls back transaction", async t => {
  const { file, drop } = await fixture(t);
  const settings = new SettingsService(file, { reasoningEffortNoneModels: ["p/base"] }); await settings.load();
  await writeFile(drop("a.yaml"), "reasoningEffortNoneModels: [p/a]"); await settings.reload();
  assert.deepEqual(settings.effective().reasoningEffortNoneModels, ["p/a"]);
  await writeFile(drop("a.yaml"), "reasoningEffortNoneModels: [p/edit]"); await settings.reload();
  const good = settings.effective();
  await writeFile(drop("b.yml"), "model: 42");
  await assert.rejects(settings.reload(), /b.yml/); assert.deepEqual(settings.effective(), good);
  await unlink(drop("b.yml")); await unlink(drop("a.yaml")); await settings.reload();
  assert.deepEqual(settings.effective().reasoningEffortNoneModels, ["p/base"]);
  await writeFile(file, "thinking: bogus"); await assert.rejects(settings.reload(), /settings.local.yaml/);
  assert.deepEqual(settings.effective().reasoningEffortNoneModels, ["p/base"]);
});

test("mutations change only local file and respect higher precedence, pending uses actual active values", async t => {
  const { file, drop } = await fixture(t);
  await writeFile(file, "model: p/local\n"); await writeFile(drop("a.yaml"), "model: p/drop\nskills: {context: lazy}\n");
  const settings = new SettingsService(file, {}); await settings.load();
  await settings.set("model", "p/command");
  assert.equal(settings.effective().model, "p/drop");
  assert.deepEqual(parse(await readFile(file, "utf8")), { model: "p/command" });
  await writeFile(drop("a.yaml"), "model: p/edited\nskills: {context: off}\n"); await settings.reload();
  assert.equal(settings.effective().model, "p/edited"); assert.equal(settings.effective().skills?.context, "lazy");
  assert.ok(!settings.restartPending.includes("model")); assert.ok(settings.restartPending.includes("skills"));
  await settings.set("thinking", "off");
  assert.equal(settings.effective().model, "p/edited"); assert.ok(!settings.restartPending.includes("model"));
  const restarted = new SettingsService(file, {}); await restarted.load(); assert.equal(restarted.effective().model, "p/edited");
  await unlink(drop("a.yaml")); await settings.reload();
  assert.equal(settings.effective().model, "p/command");
  const deletedRestart = new SettingsService(file, {}); await deletedRestart.load(); assert.equal(deletedRestart.effective().model, "p/command");
});

test("symlinks, directories masquerading as files and malformed YAML fail closed", async t => {
  const { home, file, drop } = await fixture(t);
  const settings = new SettingsService(file, { model: "p/base" }); await settings.load();
  await writeFile(path.join(home, "outside"), "model: p/outside");
  await symlink(path.join(home, "outside"), drop("link.yaml"));
  await assert.rejects(settings.reload(), /link.yaml/); await unlink(drop("link.yaml"));
  await mkdir(drop("dir.yml")); await assert.rejects(settings.reload(), /dir.yml/); await rm(drop("dir.yml"), { recursive: true });
  await writeFile(drop("bad.yaml"), "model: ["); await assert.rejects(settings.reload(), /bad.yaml/);
  assert.equal(settings.effective().model, "p/base");
});
