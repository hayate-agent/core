import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalMemory } from "../src/memory-local.js";
import { memoryConfig } from "../src/memory.js";

for (const admitted of [1, 2]) test(`LocalMemory.open retains admitted entry limit ${admitted}`, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-open-"));
  const config = memoryConfig({ maxEntries: admitted });
  const opening = LocalMemory.open(home, config);
  config.maxEntries = admitted === 1 ? 2 : 1;
  const memory = await opening;
  try {
    for (let i = 0; i < admitted; i++) await memory.put({ sessionKey: "fixture" }, { key: `entry-${i}`, title: "Fixture", text: `Value ${i}` });
    await assert.rejects(memory.put({ sessionKey: "fixture" }, { key: "overflow", title: "Fixture", text: "Overflow" }), /budget exceeded/);
    assert.equal((await memory.status()).entries, admitted);
  } finally { await memory.close(); await rm(home, { recursive: true, force: true }); }
});

test("LocalMemory.open retains nested embedding configuration", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-open-"));
  const config = memoryConfig({ embedding: { url: "http://127.0.0.1:1", model: "fixture", dimensions: 2 } });
  const opening = LocalMemory.open(home, config);
  // Invalid replacement would prevent worker startup if it observes caller mutation.
  config.embedding!.dimensions = 0;
  let memory: LocalMemory | undefined;
  try {
    memory = await opening;
    assert.equal(memory.capabilities.semantic, true);
    assert.equal((await memory.status()).semantic, "ready");
  } finally { await memory?.close(); await rm(home, { recursive: true, force: true }); }
});
