// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunRegistry } from "../src/api/runs.js";

const valid = { type: "usage" as const, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.125 };
for (const field of ["input", "output", "cacheRead", "cacheWrite", "costUsd"] as const) {
  test(`invalid first ${field} does not allocate usage or publish an event`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "atomic-first-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const registry = new RunRegistry(path.join(home, "runs.json"));
    const record = registry.create({ session_key: "test" });
    const before = structuredClone(record);
    const seen: unknown[] = [];
    const subscription = registry.subscribe(record.run_id, -1, event => seen.push(event));
    t.after(() => subscription.unsubscribe());
    registry.turnEvent(record.run_id, { ...valid, [field]: NaN, model: "untrusted/model" });
    assert.deepEqual(record, before);
    assert.deepEqual(seen, []);
    registry.turnEvent(record.run_id, valid);
    assert.deepEqual(record.usage, { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4 });
    assert.equal(record.cost_usd, 0.125);
    assert.equal(seen.length, 1);
    await registry.finish(record.run_id, "done");
    const restored = new RunRegistry(path.join(home, "runs.json"));
    await restored.load();
    assert.equal(restored.get(record.run_id)?.cost_usd, 0.125);
  });
}
for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
  test(`${field} total overflow leaves all counters and cost unchanged`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "atomic-overflow-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const registry = new RunRegistry(path.join(home, "runs.json"));
    const record = registry.create({ session_key: "test" });
    registry.turnEvent(record.run_id, { ...valid, [field]: Number.MAX_SAFE_INTEGER });
    const before = structuredClone(record);
    registry.turnEvent(record.run_id, valid);
    assert.deepEqual(record, before);
  });
}
