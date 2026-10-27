import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";

test("nightly selection persists replacement/disable and restores installation baseline on restart", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.yaml");
  const service = () => new SettingsService(file, { nightlyStrategy: "installation.mjs" });
  let settings = service(); await settings.load();
  assert.equal(settings.effective().nightlyStrategy, "installation.mjs");
  await settings.setNightlyStrategy("custom.mjs");
  settings = service(); await settings.load(); assert.equal(settings.effective().nightlyStrategy, "custom.mjs");
  await settings.setNightlyStrategy(null);
  settings = service(); await settings.load(); assert.equal(settings.effective().nightlyStrategy, null);
  await assert.rejects(settings.setNightlyStrategy(" "), /Invalid nightly/);
  assert.equal(settings.effective().nightlyStrategy, null);
  await settings.setNightlyStrategy(undefined);
  settings = service(); await settings.load(); assert.equal(settings.effective().nightlyStrategy, "installation.mjs");
  assert.ok(!Object.hasOwn(settings.snapshot(), "nightlyStrategy"));
});

test("failed settings persistence keeps active selection", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "nightly-settings-fail-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const parent = path.join(home, "parent"), file = path.join(parent, "settings.yaml");
  await mkdir(parent);
  const settings = new SettingsService(file, {}); await settings.load();
  await settings.setNightlyStrategy("custom.mjs");
  await rm(parent, { recursive: true }); await writeFile(parent, "block writes");
  await assert.rejects(settings.setNightlyStrategy(null));
  assert.equal(settings.effective().nightlyStrategy, "custom.mjs");
});
