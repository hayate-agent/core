import test from "node:test";
import assert from "node:assert/strict";
import { MemoryProviderLifecycle } from "../src/memory-provider-lifecycle.js";
import { memoryConfig, type MemoryProvider } from "../src/memory.js";
import { MemoryService } from "../src/builtin-plugins/memory-service.js";
import { LocalMemory } from "../src/memory-local.js";
import { FileMemoryStore } from "../src/memory-worker.js";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let unhealthy = false, closes = 0;
  const provider: MemoryProvider = {
    capabilities: { semantic: true, revisions: true },
    async status() { if (unhealthy) throw Error("offline"); return {} as any; },
    async put() { return {} as any; }, async get() { return undefined; }, async search() { return []; },
    async revise() { return {} as any; }, async forget() {}, async reindex() {}, async close() { closes++; },
  };
  return { provider, fail() { unhealthy = true; }, get closes() { return closes; } };
}
const tick = () => new Promise(r => setImmediate(r));

test("real capture backlog flush retains facade lease while reconnect drains", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-facade-flush-"));
  const first = fixture(), second = fixture(), gate = deferred(), entered = deferred();
  const store = new FileMemoryStore(path.join(home, "store"), memoryConfig());
  await store.start();
  let writes = 0, opens = 0;
  // Capture must receive a valid provider-authoritative entry, including its ID.
  first.provider.put = async (context, entry) => { writes++; entered.resolve(); await gate.promise; return store.put(context, entry); };
  const lifecycle = new MemoryProviderLifecycle(async () => ++opens === 1 ? first.provider : second.provider);
  try {
    const service = new MemoryService(memoryConfig(), () => {}, home);
    await service.capture({ id: "pending", sessionKey: "test", text: "input", reply: "answer", outcome: "failed" });
    service.provider = lifecycle; await lifecycle.ensureConnected();
    const flush = service.flush(); await entered.promise;
    first.fail(); const reconnect = lifecycle.ensureConnected(); await tick();
    assert.equal(first.closes, 0); assert.equal(opens, 1);
    gate.resolve(); await flush; await reconnect;
    assert.equal(service.provider, lifecycle); assert.equal(writes, 1);
    assert.deepEqual(await readdir(path.join(home, "memory-pending")), []);
    assert.equal(first.closes, 1); assert.equal(opens, 2);
    assert.equal((await store.status()).entries, 1);
  } finally { gate.resolve(); await lifecycle.close(); await store.close(); await rm(home, { recursive: true, force: true }); }
});

test("real LocalMemory reconnect releases exclusive store lock and retains data", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-facade-local-"));
  let unhealthy = false, opens = 0;
  const lifecycle = new MemoryProviderLifecycle(async () => {
    const store = await LocalMemory.open(home, memoryConfig()); opens++;
    const status = store.status.bind(store);
    store.status = async () => { if (unhealthy) { unhealthy = false; throw Error("health fixture"); } return status(); };
    return store;
  });
  try {
    await lifecycle.ensureConnected();
    const entry = await lifecycle.put({ sessionKey: "test" }, { key: "one", title: "Retained", text: "durable record", source: "test" });
    unhealthy = true; await lifecycle.ensureConnected(); assert.equal(opens, 2);
    assert.equal((await lifecycle.get({ sessionKey: "test" }, entry.id))?.text, "durable record");
  } finally { await lifecycle.close(); await rm(home, { recursive: true, force: true }); }
});

test("exclusive reconnect drains leased calls and closes before opening same store", async () => {
  const first = fixture(), second = fixture(), gate = deferred(), started = deferred();
  first.provider.search = async () => { started.resolve(); await gate.promise; return []; };
  let opens = 0;
  const lifecycle = new MemoryProviderLifecycle(async () => {
    opens++; if (opens === 2) assert.equal(first.closes, 1); return opens === 1 ? first.provider : second.provider;
  });
  await lifecycle.ensureConnected();
  const running = lifecycle.search({ sessionKey: "test" }, "query"); await started.promise;
  first.fail(); const reconnect = lifecycle.ensureConnected();
  assert.equal(lifecycle.ensureConnected(), reconnect);
  await tick(); assert.equal(opens, 1); assert.equal(first.closes, 0);
  await assert.rejects(lifecycle.reindex(), /unavailable/);
  gate.resolve(); await running; await reconnect;
  assert.equal(opens, 2); assert.deepEqual(lifecycle.capabilities, second.provider.capabilities);
  await lifecycle.close(); assert.equal(second.closes, 1);
});

test("stop during activation waits and closes unpublished candidate exactly once", async () => {
  const gate = deferred(), started = deferred(), candidate = fixture();
  const lifecycle = new MemoryProviderLifecycle(async () => { started.resolve(); await gate.promise; return candidate.provider; });
  const connecting = lifecycle.ensureConnected(); await started.promise;
  let done = false; const stop = lifecycle.close(); assert.equal(lifecycle.close(), stop);
  void stop.then(() => { done = true; }); await tick(); assert.equal(done, false);
  gate.resolve(); await connecting; await stop;
  assert.equal(candidate.closes, 1);
  await assert.rejects(lifecycle.status(), /unavailable/);
  await assert.rejects(lifecycle.ensureConnected(), /restart required/);
});

test("cleanup failure blocks reconnect, stop reports failure without retrying cleanup", async () => {
  const first = fixture(); let closes = 0, opens = 0;
  first.provider.close = async () => { closes++; throw Error("private backend detail"); };
  const lifecycle = new MemoryProviderLifecycle(async () => { opens++; return first.provider; });
  await lifecycle.ensureConnected(); first.fail();
  await assert.rejects(lifecycle.ensureConnected(), /cleanup failed; restart required/);
  await assert.rejects(lifecycle.ensureConnected(), /restart required/);
  await assert.rejects(lifecycle.close(), /cleanup failed/);
  assert.equal(opens, 1); assert.equal(closes, 1);
});

test("factory failure can retry; all provider methods go through stable facade", async () => {
  const candidate = fixture(); let opens = 0; const calls: string[] = [];
  for (const name of ["put", "get", "search", "revise", "forget", "reindex"] as const) {
    (candidate.provider as any)[name] = async () => { calls.push(name); };
  }
  const lifecycle = new MemoryProviderLifecycle(async () => { if (++opens === 1) throw Error("open failed"); return candidate.provider; });
  await assert.rejects(lifecycle.ensureConnected(), /open failed/);
  await lifecycle.ensureConnected();
  await lifecycle.put({ sessionKey: "test" }, {} as any); await lifecycle.get({ sessionKey: "test" }, "id");
  await lifecycle.search({ sessionKey: "test" }, "query"); await lifecycle.revise({ sessionKey: "test" }, "id", "rev", {});
  await lifecycle.forget({ sessionKey: "test" }, "id", "rev"); await lifecycle.reindex();
  assert.deepEqual(calls, ["put", "get", "search", "revise", "forget", "reindex"]);
  await lifecycle.ensureConnected(); assert.equal(opens, 2);
  await lifecycle.close();
});

test("stop drains direct and background operations plus awaited cleanup", async () => {
  const candidate = fixture(), gate = deferred(), cleanup = deferred();
  let calls = 0, closed = false;
  candidate.provider.put = async () => { calls++; await gate.promise; return {} as any; };
  candidate.provider.close = async () => { await cleanup.promise; closed = true; };
  const lifecycle = new MemoryProviderLifecycle(async () => candidate.provider);
  await lifecycle.ensureConnected();
  const writes = [lifecycle.put({ sessionKey: "a" }, {} as any), lifecycle.put({ sessionKey: "b" }, {} as any)];
  let stopped = false; const stop = lifecycle.close(); void stop.then(() => { stopped = true; });
  await tick(); assert.equal(calls, 2); assert.equal(stopped, false);
  gate.resolve(); await Promise.all(writes); await tick(); assert.equal(stopped, false);
  cleanup.resolve(); await stop; assert.equal(closed, true);
});
