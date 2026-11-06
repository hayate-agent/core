// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, unlink, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";

for (const layered of [false, true]) test(`file model defaults are atomic and removable (${layered ? "layers" : "legacy"})`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "model-live-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (layered) await mkdir(path.join(home, "settings.d"));
  const file = path.join(home, "settings.local.yaml");
  const edited = layered ? path.join(home, "settings.d", "a.yaml") : file;
  const settings = new SettingsService(file, { model: "p/install", thinking: "low", review: { thinking: "medium" } });
  await settings.load();
  await writeFile(edited, "model: p/new\nthinking: high\nreview: {model: p/review, thinking: off}\n");
  await settings.reload();
  assert.equal(settings.effective().model, "p/new");
  assert.equal(settings.effective().thinking, "high");
  assert.deepEqual(settings.effective().review, { model: "p/review", thinking: "off" });
  assert.ok(!settings.restartPending.some(k => ["model", "thinking", "review"].includes(k)));
  const good = settings.effective(), revision = settings.revision;
  await writeFile(edited, "model: p/partial\nreview: {thinking: invalid}\n");
  await settings.reload().catch(() => {});
  assert.deepEqual(settings.effective(), good);
  assert.equal(settings.revision, revision);
  await writeFile(edited, "review: {thinking: high}\n"); await settings.reload();
  assert.equal(settings.effective().model, "p/install");
  assert.equal(settings.effective().thinking, "low");
  assert.deepEqual(settings.effective().review, { thinking: "high" });
  await unlink(edited); await settings.reload();
  assert.equal(settings.effective().model, "p/install");
  assert.deepEqual(settings.effective().review, { thinking: "medium" });
});

test("CLI refreshes each review entry boundary before the plugin captures arguments", async () => {
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(source, /if \(tool === "plugin_review"\) await reloadRuntimeSettings\(\)/);
  assert.match(source, /afterTurn: async[^]*?await reloadRuntimeSettings\(\);\s*const result = await plugins.policies.finish/);
  assert.match(source, /plugins.commands.set\("review"[^]*?await reloadRuntimeSettings\(\);\s*return reviewCommand.run/);
  assert.match(source, /reloadError = message;\s*}\s*updateReviewDefaults\(\)/);
});
