import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";

test("completion selection persists replacement/disable and restores installation baseline on restart", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "completion-settings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.yaml");
  const service = () => new SettingsService(file, { completionStrategy: "installation.mjs" });
  let settings = service(); await settings.load();
  assert.equal(settings.effective().completionStrategy, "installation.mjs");
  await settings.setCompletionStrategy("custom.mjs");
  settings = service(); await settings.load(); assert.equal(settings.effective().completionStrategy, "custom.mjs");
  await settings.setCompletionStrategy(null);
  settings = service(); await settings.load(); assert.equal(settings.effective().completionStrategy, null);
  await assert.rejects(settings.setCompletionStrategy(" "), /Invalid completion/);
  assert.equal(settings.effective().completionStrategy, null);
  await settings.setCompletionStrategy(undefined);
  settings = service(); await settings.load(); assert.equal(settings.effective().completionStrategy, "installation.mjs");
  assert.ok(!Object.hasOwn(settings.snapshot(), "completionStrategy"));
});

test("failed settings persistence keeps active selection", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "completion-settings-fail-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const parent = path.join(home, "parent"), file = path.join(parent, "settings.yaml");
  await mkdir(parent);
  const settings = new SettingsService(file, {}); await settings.load();
  await settings.setCompletionStrategy("custom.mjs");
  await rm(parent, { recursive: true }); await writeFile(parent, "block writes");
  await assert.rejects(settings.setCompletionStrategy(null));
  assert.equal(settings.effective().completionStrategy, "custom.mjs");
});
