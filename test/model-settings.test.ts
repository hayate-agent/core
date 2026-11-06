import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateModelSetting } from "../src/model-settings.js";
import { SettingsService } from "../src/settings.js";

test("local overlay persists only overrides; reset exposes changed installation defaults", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.local.yaml");
  const service = new SettingsService(file, { model: "p/default", review: { thinking: "medium" } });
  await service.load();
  assert.equal(service.source("model"), "installation/default");
  await Promise.all([service.set("model", "p/local"), service.set("review.model", "p/reviewer")]);
  assert.equal(service.source("model"), "local overlay");
  assert.doesNotMatch(await readFile(file, "utf8"), /medium|p\/default/);
  const restarted = new SettingsService(file, { model: "p/new-default", review: { thinking: "high" } });
  await restarted.load();
  assert.equal(restarted.effective().model, "p/local");
  assert.equal(restarted.effective().review?.thinking, "high");
  await restarted.set("model");
  assert.equal(restarted.effective().model, "p/new-default");
  await restarted.set("review.model");
  assert.deepEqual(restarted.snapshot(), {});
});

test("overlay ignores invalid fields; programmatic writes still reject invalid values", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "settings.local.yaml");
  const service = new SettingsService(file, {});
  await assert.rejects(service.set("model", "invalid"));
  await assert.rejects(service.set("thinking", "invented"));
  assert.deepEqual(service.snapshot(), {});
  for (const content of ["token: secret", "review: []", "model: [broken", "review:\n  enabled: false"]) {
    await writeFile(file, content);
    await service.load();
    assert.equal(service.effective().model, undefined);
    assert.equal(service.effective().review?.model, undefined);
    assert.equal(service.effective().review?.thinking, undefined);
    assert.ok(service.diagnostics.length);
  }
  validateModelSetting("reviewModel", "homelab/gpt-6.1-sol");
});
