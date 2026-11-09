import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileMemoryStore, memoryUsageWeight } from "../src/memory-worker.js";
import { memoryConfig } from "../src/memory.js";

test("usage bonus is bounded, fades without removing knowledge, and ignores invalid metrics", () => {
  const now = Date.now();
  assert.equal(memoryUsageWeight(undefined, now), 1);
  assert.equal(memoryUsageWeight({ count: NaN, lastUsed: now }, now), 1);
  const fresh = memoryUsageWeight({ count: 1000000, lastUsed: now }, now);
  const old = memoryUsageWeight({ count: 1000000, lastUsed: now - 365 * 86400000 }, now);
  assert.equal(fresh, 1.25);
  assert.ok(old > 1 && old < fresh);
});

test("returned-hit usage survives reindex/restart without changing source revisions or session scope", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-usage-"));
  const ctx = { sessionKey: "one" };
  let store = new FileMemoryStore(dir, memoryConfig());
  try {
    await store.start();
    const a = await store.put(ctx, { key: "a", title: "shared apple", text: "reference" });
    const b = await store.put(ctx, { key: "b", title: "shared banana", text: "reference" });
    await store.put({ sessionKey: "other" }, { key: "foreign", title: "shared banana", text: "private" });
    const file = path.join(dir, "entries", `${b.id}.md`);
    const original = await readFile(file, "utf8");
    await store.search(ctx, "banana");
    assert.equal((await store.search(ctx, "shared", { limit: 1 }))[0].entry.id, b.id);
    await store.reindex();
    await store.close();
    store = new FileMemoryStore(dir, memoryConfig());
    await store.start();
    await store.reindex();
    assert.equal((await store.search(ctx, "shared", { limit: 1 }))[0].entry.id, b.id);
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal((await store.get(ctx, b.id))?.revision, b.revision);
    assert.equal((await store.search(ctx, "apple"))[0].entry.id, a.id);
    assert.equal((await store.search(ctx, "shared")).length, 2);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
