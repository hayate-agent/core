// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";

test("compaction selection persists registered replacement/native and restores installation baseline on restart", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "compaction-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.yaml");
  const service = () => new SettingsService(file, { compactionStrategy: "installation.mjs" });
  let settings = service(); await settings.load();
  assert.equal(settings.effective().compactionStrategy, "installation.mjs");
  await settings.setCompactionStrategy("custom.mjs");
  settings = service(); await settings.load(); assert.equal(settings.effective().compactionStrategy, "custom.mjs");
  await settings.setCompactionStrategy("native");
  settings = service(); await settings.load(); assert.equal(settings.effective().compactionStrategy, "native");
  await assert.rejects(settings.setCompactionStrategy(" "), /Invalid compaction/);
  await assert.rejects(settings.setCompactionStrategy(null as any), /Invalid compaction/);
  assert.equal(settings.effective().compactionStrategy, "native");
  await settings.setCompactionStrategy(undefined);
  settings = service(); await settings.load(); assert.equal(settings.effective().compactionStrategy, "installation.mjs");
  assert.ok(!Object.hasOwn(settings.snapshot(), "compactionStrategy"));
});

test("failed settings persistence keeps active selection", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "compaction-settings-fail-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const parent = path.join(home, "parent"), file = path.join(parent, "settings.yaml");
  await mkdir(parent);
  const settings = new SettingsService(file, {}); await settings.load();
  await settings.setCompactionStrategy("custom.mjs");
  await rm(parent, { recursive: true }); await writeFile(parent, "block writes");
  await assert.rejects(settings.setCompactionStrategy("native"));
  assert.equal(settings.effective().compactionStrategy, "custom.mjs");
});
