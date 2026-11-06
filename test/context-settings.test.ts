import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";

test("context selection persists replacement/disable and restores installation baseline on restart", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.yaml");
  const service = () => new SettingsService(file, { contextStrategy: "installation.mjs" });
  let settings = service(); await settings.load();
  assert.equal(settings.effective().contextStrategy, "installation.mjs");
  await settings.setContextStrategy("custom.mjs");
  settings = service(); await settings.load(); assert.equal(settings.effective().contextStrategy, "custom.mjs");
  await settings.setContextStrategy(null);
  settings = service(); await settings.load(); assert.equal(settings.effective().contextStrategy, null);
  await assert.rejects(settings.setContextStrategy(" "), /Invalid context/);
  assert.equal(settings.effective().contextStrategy, null);
  await settings.setContextStrategy(undefined);
  settings = service(); await settings.load(); assert.equal(settings.effective().contextStrategy, "installation.mjs");
  assert.ok(!Object.hasOwn(settings.snapshot(), "contextStrategy"));
});

test("failed settings persistence keeps active selection", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-settings-fail-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const parent = path.join(home, "parent"), file = path.join(parent, "settings.yaml");
  await mkdir(parent);
  const settings = new SettingsService(file, {}); await settings.load();
  await settings.setContextStrategy("custom.mjs");
  await rm(parent, { recursive: true }); await writeFile(parent, "block writes");
  await assert.rejects(settings.setContextStrategy(null));
  assert.equal(settings.effective().contextStrategy, "custom.mjs");
});
