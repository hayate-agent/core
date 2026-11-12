import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SettingsService } from "../src/settings.js";
import { benchmarkConfig, benchmarkConfigDefaults } from "../src/benchmark/config.js";

const INSTALLATION = { benchmark: { enabled: true, capacity: 3, repeats: 3, caseTimeoutMs: 900_000 } };

async function load(contents?: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "benchmark-config-"));
  const file = path.join(dir, "settings.local.yaml");
  if (contents !== undefined) await writeFile(file, contents);
  const diagnostics: string[] = [];
  const settings = new SettingsService(file, INSTALLATION, message => diagnostics.push(message));
  await settings.load();
  return { settings, diagnostics, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("benchmarkConfig fills defaults and refuses values that would distort a run", () => {
  assert.deepEqual(benchmarkConfig(), benchmarkConfigDefaults);
  assert.deepEqual(benchmarkConfig({ capacity: 2 }), { ...benchmarkConfigDefaults, capacity: 2 });
  assert.deepEqual(benchmarkConfig(undefined), benchmarkConfigDefaults);
  for (const value of [{ capacity: 0 }, { capacity: 5 }, { capacity: 1.5 }, { repeats: 0 }, { repeats: 21 },
    { caseTimeoutMs: 30_000 }, { caseTimeoutMs: 7 * 3_600_000 }, { runsDir: "relative/path" }, { enabled: "yes" }, null, [] ])
    assert.throws(() => benchmarkConfig(value as never), /Invalid benchmark configuration/, JSON.stringify(value));
});

test("a valid benchmark overlay merges per field over the installation default", async () => {
  const f = await load("benchmark:\n  capacity: 2\n  repeats: 5\n");
  try {
    assert.deepEqual(f.settings.effective().benchmark, { enabled: true, capacity: 2, repeats: 5, caseTimeoutMs: 900_000 });
    assert.deepEqual(f.diagnostics, []);
  } finally { await f.cleanup(); }
});

test("an unusable benchmark block is dropped whole instead of half applied", async () => {
  for (const contents of ["benchmark:\n  capacity: 2\n  turbo: true\n", "benchmark:\n  capacity: 0\n"]) {
    const f = await load(contents);
    try {
      assert.deepEqual(f.settings.effective().benchmark, INSTALLATION.benchmark, contents);
      assert.deepEqual(f.diagnostics, ["Ignored benchmark: invalid or unsupported setting."], contents);
    } finally { await f.cleanup(); }
  }
});

test("absence of the block restores the installation selection", async () => {
  const f = await load();
  try {
    assert.deepEqual(f.settings.effective().benchmark, INSTALLATION.benchmark);
    assert.deepEqual(f.diagnostics, []);
  } finally { await f.cleanup(); }
});
