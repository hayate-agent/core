import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../src/settings.js";

test("explicit commands preserve current live review defaults", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dropin-mutations-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "settings.d"));
  const file = path.join(home, "settings.local.yaml");
  await writeFile(file, "model: p/old\nreview: {model: p/old, thinking: low}\n");
  const settings = new SettingsService(file, {}); await settings.load();
  await writeFile(file, "model: p/new\nreview: {model: p/new, thinking: low}\n");
  await settings.reload();
  await settings.set("review.thinking", "high");
  assert.equal(settings.effective().review?.model, "p/new");
  assert.equal(settings.effective().review?.thinking, "high");
  assert.ok(!settings.restartPending.includes("review"));
  await settings.set("model", "p/new");
  assert.equal(settings.effective().model, "p/new");
  assert.ok(!settings.restartPending.includes("model"));
});

test("removing settings.d recomputes pending rather than reverting to salvage mode", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dropin-removal-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "settings.d"); await mkdir(dir);
  const file = path.join(home, "settings.local.yaml"); await writeFile(file, "model: p/local");
  const settings = new SettingsService(file, {}); await settings.load();
  await writeFile(path.join(dir, "a.yml"), "model: p/changed"); await settings.reload();
  assert.equal(settings.effective().model, "p/changed");
  assert.ok(!settings.restartPending.includes("model"));
  await rm(dir, { recursive: true }); await settings.reload();
  assert.deepEqual(settings.restartPending, []);
});
