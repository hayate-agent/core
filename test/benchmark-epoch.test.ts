import assert from "node:assert/strict";
import { test } from "node:test";
import { benchmarkEpoch, epochDifferences } from "../src/benchmark/epoch.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "benchmark-epoch-"));
  const settingsDir = path.join(home, "settings.d");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(path.join(home, "build-info.json"), JSON.stringify({ version: "0.1.208", revision: "a4c0a61" }));
  await writeFile(path.join(home, "models.json"), JSON.stringify({ provider: { models: ["a"] } }));
  await writeFile(path.join(home, "settings.local.yaml"), "model: homelab/a\n");
  await writeFile(path.join(settingsDir, "90-scheduled.yaml"), "a: 1\n");
  await writeFile(path.join(settingsDir, "99-model-roles.yaml"), "b: 2\n");
  return { home, settingsDir, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("epoch fingerprints the build, the model definitions and every settings dropin", async () => {
  const f = await fixture();
  try {
    const epoch = await benchmarkEpoch(f.home);
    assert.equal(epoch.revision, "a4c0a61");
    assert.equal(epoch.version, "0.1.208");
    assert.match(epoch.modelsFingerprint, /^[0-9a-f]{16}$/);
    assert.match(epoch.settingsFingerprint, /^[0-9a-f]{16}$/);
    assert.deepEqual(epochDifferences(epoch, await benchmarkEpoch(f.home)), []);
  } finally { await f.cleanup(); }
});

test("a settings dropin edit and a models.json edit both break comparability", async () => {
  const f = await fixture();
  try {
    const before = await benchmarkEpoch(f.home);
    await writeFile(path.join(f.settingsDir, "99-model-roles.yaml"), "b: 3\n");
    assert.deepEqual(epochDifferences(before, await benchmarkEpoch(f.home)), ["settingsFingerprint"]);
    const afterSettings = await benchmarkEpoch(f.home);
    await writeFile(path.join(f.home, "models.json"), JSON.stringify({ provider: { models: ["a", "b"] } }));
    assert.deepEqual(epochDifferences(afterSettings, await benchmarkEpoch(f.home)), ["modelsFingerprint"]);
    await writeFile(path.join(f.home, "build-info.json"), JSON.stringify({ revision: "deadbeef" }));
    assert.deepEqual(epochDifferences(before, await benchmarkEpoch(f.home)), ["revision", "version", "modelsFingerprint", "settingsFingerprint"]);
  } finally { await f.cleanup(); }
});

test("missing infrastructure degrades to a stable marker instead of throwing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "benchmark-epoch-empty-"));
  try {
    const epoch = await benchmarkEpoch(home);
    assert.equal(epoch.revision, "unknown");
    assert.equal(epoch.version, undefined);
    assert.equal(epoch.modelsFingerprint, "absent");
    assert.equal(epoch.settingsFingerprint, "absent");
    assert.deepEqual(epochDifferences(epoch, await benchmarkEpoch(home)), []);
  } finally { await rm(home, { recursive: true, force: true }); }
});
