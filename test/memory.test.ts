import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import { FileMemoryStore } from "../src/memory-worker.js";
import { LocalMemory } from "../src/memory-local.js";
import { memoryConfig } from "../src/memory.js";
import { MemoryService } from "../src/memory-plugin.js";
const ctx = { sessionKey: "matrix:one" };
const input = { key: "lesson-1", title: "Deployment verification", text: "Check running artifact hashes, not only merge status.", source: "turn:1", kind: "lesson" as const };
async function setup(t: any) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-memory-"));
  const store = new FileMemoryStore(dir, memoryConfig({ enabled: true }));
  await store.start();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  return { store, dir };
}
test("memory durable write, restart, idempotency and isolation", async (t) => {
  const { store, dir } = await setup(t);
  const entry = await store.put(ctx, input);
  assert.deepEqual(await store.put(ctx, input), entry);
  await assert.rejects(store.put(ctx, { ...input, text: "different" }), /conflict/);
  await assert.rejects(store.put(ctx, { ...input, expiresAt: "2000-01-01T00:00:00Z" }), /conflict/);
  await assert.rejects(store.put(ctx, { ...input, reviewAfter: "2000-01-01T00:00:00Z" }), /conflict/);
  assert.equal(await store.get({ sessionKey: "other" }, entry.id), undefined);
  assert.deepEqual(await store.search({ sessionKey: "other" }, "artifact"), []);
  assert.equal((await store.search(ctx, "artifact"))[0].entry.id, entry.id);
  const long = await store.put(ctx, { ...input, key: "long-tail", text: Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ") + " uniquetail" });
  assert.equal((await store.search(ctx, "uniquetail"))[0].entry.id, long.id);
  await assert.rejects(store.revise(ctx, entry.id, "bad", { state: "archived" }), /revision/);
  await store.close();
  const restored = new FileMemoryStore(dir, memoryConfig());
  await restored.start();
  try { assert.equal((await restored.search(ctx, "artifact"))[0].entry.id, entry.id); }
  finally { await restored.close(); }
});
test("memory text preserves trailing whitespace through reads, reindex and restart", async (t) => {
  const { store, dir } = await setup(t);
  const text = "Operator correction  \n\n";
  const entry = await store.put(ctx, { ...input, text });
  assert.equal((await store.get(ctx, entry.id))?.text, text);
  await store.reindex();
  assert.equal((await store.get(ctx, entry.id))?.text, text);
  await store.close();
  const restored = new FileMemoryStore(dir, memoryConfig()); await restored.start();
  try {
    assert.equal((await restored.get(ctx, entry.id))?.text, text);
    const revised = await restored.revise(ctx, entry.id, entry.revision, { text: "Updated\t \n" });
    assert.equal((await restored.get(ctx, revised.id))?.text, "Updated\t \n");
  } finally { await restored.close(); }
});

test("expiry, revoke and manual changes are enforced even against stale index", async (t) => {
  const { store, dir } = await setup(t);
  const entry = await store.put(ctx, input);
  const file = path.join(dir, "entries", entry.id + ".md");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace("state: active", "state: revoked"));
  assert.deepEqual(await store.search(ctx, "artifact"), []);
  assert.equal((await store.search(ctx, "artifact", { historical: true }))[0].entry.state, "revoked");
  await assert.rejects(store.revise(ctx, entry.id, entry.revision, { text: "stale overwrite" }), /revision/);
  const changed = await store.get(ctx, entry.id);
  await store.revise(ctx, entry.id, changed!.revision, { state: "active", expiresAt: "2000-01-01T00:00:00Z" });
  assert.deepEqual(await store.search(ctx, "artifact"), []);
  const current = await store.get(ctx, entry.id);
  await store.forget(ctx, entry.id, current!.revision);
  assert.equal(await store.get(ctx, entry.id), undefined);
  assert.deepEqual(await store.search(ctx, "artifact", { historical: true }), []);
});
test("manual edits indexed, corrupt snapshot rebuilds and invalid entries isolated", async (t) => {
  const { store, dir } = await setup(t);
  const entry = await store.put(ctx, input);
  const file = path.join(dir, "entries", entry.id + ".md");
  await writeFile(file, (await readFile(file, "utf8")).replace("artifact hashes", "kubernetes signatures"));
  await store.reindex();
  assert.equal((await store.search(ctx, "kubernetes"))[0].entry.id, entry.id);
  await store.close();
  await writeFile(path.join(dir, "index.json"), "{broken");
  const rebuilt = new FileMemoryStore(dir, memoryConfig()); await rebuilt.start();
  try { await rebuilt.reindex(); assert.equal((await rebuilt.search(ctx, "kubernetes")).length, 1); }
  finally { await rebuilt.close(); }
});
test("worker owns storage lock, persists across process restarts", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-worker-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const provider = await LocalMemory.open(home, memoryConfig());
  try {
    await assert.rejects(LocalMemory.open(home, memoryConfig()));
    const entry = await provider.put(ctx, input);
    assert.equal((await provider.get(ctx, entry.id))?.id, entry.id);
  } finally { await provider.close(); }
  const next = await LocalMemory.open(home, memoryConfig());
  try { assert.equal((await next.search(ctx, "artifact")).length, 1); } finally { await next.close(); }
});
test("write budget rejects before committing and accepted memories survive rebuild", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-budget-"));
  const store = new FileMemoryStore(dir, memoryConfig({ maxIndexBytes: 65536 }));
  await store.start();
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  let revisionEntry = await store.put(ctx, { ...input, key: "revision-budget" });
  const cost = (store as any).indexCost;
  for (let i = 0; i < 20; i++) revisionEntry = await store.revise(ctx, revisionEntry.id, revisionEntry.revision, { text: input.text });
  assert.equal((store as any).indexCost, cost, "revision hashes must not cause budget drift");
  let accepted = 1;
  for (let i = 0; i < 20; i++) {
    try { await store.put(ctx, { ...input, key: `large-${i}`, text: "artifact ".repeat(1300) }); accepted++; }
    catch (err) { assert.match(String(err), /budget/); break; }
  }
  assert.ok(accepted > 0 && accepted < 20);
  await store.reindex();
  assert.equal((await store.status()).entries, accepted);
  assert.equal((await store.search(ctx, "artifact", { limit: 20 })).length, accepted);
});

test("semantic retrieval finds nonlexical matches, persists vectors and degrades on endpoint failure", async (t) => {
  let online = true;
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    if (!online) { res.writeHead(503).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-semantic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = memoryConfig({ embedding: { url: `http://127.0.0.1:${address.port}`, model: "test", dimensions: 3 } });
  const store = new FileMemoryStore(dir, config); await store.start();
  const entry = await store.put(ctx, input);
  for (let i = 0; i < 100 && (await store.status()).semantic !== "ready"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await store.status()).semantic, "ready", "write indexes without explicit reindex");
  const revised = await store.revise(ctx, entry.id, entry.revision, { text: "Changed artifact verification lesson" });
  for (let i = 0; i < 100 && (await store.status()).semantic !== "ready"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await store.status()).semantic, "ready", "revision indexes without explicit reindex");
  assert.equal((await store.search(ctx, "unrelated paraphrase"))[0].entry.revision, revised.revision);
  await store.close();
  const restored = new FileMemoryStore(dir, config); await restored.start();
  try {
    const before = requests;
    await restored.search(ctx, "unrelated paraphrase");
    assert.equal(requests, before + 1, "cached entry vector not regenerated");
    online = false;
    assert.equal((await restored.search(ctx, "artifact"))[0].entry.id, entry.id);
    assert.equal((await restored.status()).semantic, "degraded");
  } finally { await restored.close(); }
});

test("background embedding budget spans eager writes and reindex calls", async (t) => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-request-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = (server.address() as { port: number }).port;
  const store = new FileMemoryStore(dir, memoryConfig({ scanSeconds: 60, embedding: { url: `http://127.0.0.1:${port}`, model: "test", dimensions: 3 } }));
  await store.start();
  try {
    for (let i = 0; i < 24; i++) await store.put(ctx, { ...input, key: `budget-${i}` });
    for (let i = 0; i < 200 && requests < 16; i++) await new Promise((r) => setTimeout(r, 10));
    await store.reindex(); await store.reindex();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(requests, 16, "reindex and eager continuation cannot reset request budget");
    assert.equal((await store.status()).semantic, "degraded", "remaining vectors wait for next interval");
  } finally { await store.close(); }
});

test("capture backlog survives provider failure and retries across service restart", async (t) => {
  const { store } = await setup(t);
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-backlog-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const first = new MemoryService(memoryConfig(), () => {}, home);
  const turn = { sessionKey: ctx.sessionKey, id: "failed-turn", text: "deploy", reply: "artifact mismatch", outcome: "failed" as const, recordedAt: Date.now() };
  await first.capture(turn);
  const next = new MemoryService(memoryConfig(), () => {}, home); next.provider = store;
  await next.flush();
  assert.equal((await store.search(ctx, "artifact")).length, 1);
  await next.flush();
  assert.equal((await store.status()).entries, 1);
  await new Promise((r) => setTimeout(r, 5));
  await next.capture(turn); // replay after successful adoption and pending removal
  await next.flush();
  assert.equal((await store.status()).entries, 1);
  await next.capture({ ...turn, id: undefined, recordedAt: turn.recordedAt + 1 });
  await next.flush();
  await next.capture({ ...turn, id: undefined, recordedAt: turn.recordedAt + 2 });
  await next.flush();
  assert.equal((await store.status()).entries, 3, "distinct ID-less turns do not collide");
});

test("poison backlog entries cannot starve later valid entries", async (t) => {
  const { store } = await setup(t);
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-poison-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "memory-pending"); await mkdir(dir);
  for (let i = 0; i < 32; i++) await writeFile(path.join(dir, i.toString(16).padStart(64, "0") + ".json"), "broken");
  await writeFile(path.join(dir, "f".repeat(64) + ".json"), JSON.stringify({ sessionKey: ctx.sessionKey, entry: input }));
  const service = new MemoryService(memoryConfig(), () => {}, home); service.provider = store;
  await service.flush(); await service.flush();
  assert.equal((await store.status()).entries, 1);
});

test("automatic capture marks claims reported and recall has bounded data framing", async (t) => {
  const { store } = await setup(t);
  const service = new MemoryService(memoryConfig(), () => {}); service.provider = store;
  await service.capture({ sessionKey: ctx.sessionKey, id: "turn1", text: "Diagnose deployment", reply: "artifact mismatch", outcome: "failed" });
  const hits = await store.search(ctx, "artifact");
  assert.equal(hits[0].entry.verification, "reported");
  assert.ok(hits[0].entry.expiresAt);
  assert.match(await service.recall(ctx.sessionKey, "artifact"), /not instructions or authorization/);
});
