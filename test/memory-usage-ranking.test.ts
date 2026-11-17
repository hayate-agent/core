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

test("hourly maintenance archives stale unused turn records only; keeps handoff, explicit knowledge, sources, scopes and replay identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-maint-"));
  const store = new FileMemoryStore(dir, memoryConfig({ scanSeconds: 3600 }));
  try {
    await store.start();
    const old = new Date(Date.now() - 8 * 86400000).toISOString();
    const op = (key: string, sessionKey: string, reviewAfter = old) => store.put({ sessionKey }, { key, kind: "operation", title: `turn ${key}`, text: `dispatcher queue ${key}`, source: key, reviewAfter });
    const stale = await op("a1", "matrix:a");
    const used = await op("a2", "matrix:a");
    const fresh = await op("a3", "matrix:a", new Date(Date.now() + 86400000).toISOString());
    await new Promise(r => setTimeout(r, 5));
    const newest = await op("a4", "matrix:a"); // newest per session: handoff continuity
    const otherOnly = await op("b1", "matrix:b");
    const lesson = await store.put({ sessionKey: "matrix:a" }, { key: "l1", kind: "lesson", title: "lesson", text: "dispatcher queue lesson", source: "operator", reviewAfter: old });
    await store.search({ sessionKey: "matrix:a" }, "a2"); // recalled once → keep
    assert.equal(await store.maintain(), 1);
    const state = async (sessionKey: string, id: string) => (await store.get({ sessionKey }, id))?.state;
    assert.equal(await state("matrix:a", stale.id), "archived");
    for (const e of [used, fresh, newest, lesson]) assert.equal(await state("matrix:a", e.id), "active", e.title);
    assert.equal(await state("matrix:b", otherOnly.id), "active");
    // Archived knowledge is not deleted: source, scope and historical recall stay intact.
    const archived = await store.get({ sessionKey: "matrix:a" }, stale.id);
    assert.equal(archived?.source, "a1"); assert.equal(archived?.sessionKey, "matrix:a");
    assert.equal(await store.get({ sessionKey: "matrix:b" }, stale.id), undefined);
    assert.ok(!(await store.search({ sessionKey: "matrix:a" }, "a1")).some(h => h.entry.id === stale.id));
    assert.ok((await store.search({ sessionKey: "matrix:a" }, "a1", { historical: true })).some(h => h.entry.id === stale.id));
    // Replay of the queued capture after archiving stays idempotent (no duplicate, no conflict).
    assert.equal((await op("a1", "matrix:a")).id, stale.id);
    assert.equal((await store.status()).entries, 6);
    // Second run is a no-op; status reports the maintenance time; survives restart (Markdown authoritative).
    assert.equal(await store.maintain(), 0);
    assert.ok((await store.status()).lastMaintenance);
    await store.close();
    const reopened = new FileMemoryStore(dir, memoryConfig({ scanSeconds: 3600 }));
    await reopened.start(); await reopened.reindex();
    assert.equal((await reopened.get({ sessionKey: "matrix:a" }, stale.id))?.state, "archived");
    assert.equal((await reopened.get({ sessionKey: "matrix:a" }, newest.id))?.state, "active");
    await reopened.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("maintenance runs from the existing scan owner at most hourly and never concurrently with writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-maint-tick-"));
  const store = new FileMemoryStore(dir, memoryConfig({ scanSeconds: 3600 }));
  try {
    await store.start();
    await store.reindex(); // the existing scan owner performs the first maintenance run
    const first = (await store.status()).lastMaintenance;
    assert.ok(first);
    const old = new Date(Date.now() - 8 * 86400000).toISOString();
    const a = await store.put({ sessionKey: "s" }, { key: "x1", kind: "operation", title: "t1", text: "one", reviewAfter: old });
    await new Promise(r => setTimeout(r, 5));
    // Queued write and scan share one serial owner; a scan within the hour does not re-run maintenance.
    await Promise.all([store.put({ sessionKey: "s" }, { key: "x2", kind: "operation", title: "t2", text: "two", reviewAfter: old }), store.reindex()]);
    assert.equal((await store.status()).lastMaintenance, first);
    assert.equal((await store.get({ sessionKey: "s" }, a.id))?.state, "active");
    // Next hourly run (simulated clock) archives the stale record and keeps the newest.
    assert.equal(await store.maintain(Date.now() + 3600000), 1);
    assert.equal((await store.get({ sessionKey: "s" }, a.id))?.state, "archived");
    await store.close(); // drain: close waits for the serial queue
  } finally { await rm(dir, { recursive: true, force: true }); }
});
