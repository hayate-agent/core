import test from "node:test";
import assert from "node:assert/strict";
import { MemoryProviderLifecycle } from "../src/memory-provider-lifecycle.js";
import { memoryConfig, type MemoryProvider } from "../src/memory.js";
import { MemoryService } from "../src/builtin-plugins/memory-service.js";
import { LocalMemory } from "../src/memory-local.js";
import { FileMemoryStore } from "../src/memory-worker.js";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

test("worker memory writes land in the owning conversation scope and are retrievable there, not elsewhere", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-owner-scope-"));
  const store = new FileMemoryStore(path.join(home, "store"), memoryConfig());
  await store.start();
  const parents: Record<string, string> = { "dispatch:exec1:tok": "matrix:!room" };
  const lifecycle = new MemoryProviderLifecycle(async () => store, key => parents[key] ?? key);
  try {
    await lifecycle.ensureConnected();
    const saved = await lifecycle.put({ sessionKey: "dispatch:exec1:tok" }, { key: "worker-decision", kind: "decision", title: "Skill matching", text: "Use whole-word skill matching for diagnostics", source: "test" });
    assert.equal(saved.sessionKey, "matrix:!room");
    // Later worker of the same owner and the owner conversation itself retrieve it.
    parents["dispatch:exec2:tok"] = "matrix:!room";
    for (const key of ["dispatch:exec2:tok", "matrix:!room"]) {
      const hits = await lifecycle.search({ sessionKey: key }, "whole-word skill matching");
      assert.ok(hits.some(hit => hit.entry.id === saved.id), key);
    }
    // Other conversations and unknown workers stay isolated.
    for (const key of ["matrix:!other", "dispatch:orphan:tok"]) assert.equal((await lifecycle.search({ sessionKey: key }, "whole-word skill matching")).length, 0, key);
  } finally { await lifecycle.close?.(); await store.close?.(); await rm(home, { recursive: true, force: true }); }
});

test("owner scope: pending worker turns replay under their exact key; explicit lessons reach the owner; sources and privacy kept", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-owner-replay-"));
  const store = new FileMemoryStore(path.join(home, "store"), memoryConfig());
  await store.start();
  const worker = "dispatch:exec1:tok", owner = "matrix:!room";
  const parents: Record<string, string> = {};
  try {
    // Before the update: worker turn queued and already persisted under the worker key (uncertain ack).
    const service = new MemoryService(memoryConfig({ enabled: true }), () => {}, home);
    await service.capture({ id: "w1", sessionKey: worker, text: "diagnose dispatcher", reply: "found queue hold", outcome: "completed", recordedAt: 1 });
    const [file] = await readdir(path.join(home, "memory-pending"));
    const bytes = await readFile(path.join(home, "memory-pending", file));
    service.provider = store; await service.flush();
    assert.equal((await store.status()).entries, 1);
    // Lost acknowledgement: the exact queued bytes survive into the updated runtime.
    await writeFile(path.join(home, "memory-pending", file), bytes);
    // Updated runtime: worker now has a known owner; replay the same capture.
    parents[worker] = owner;
    const lifecycle = new MemoryProviderLifecycle(async () => store, key => parents[key] ?? key);
    await lifecycle.ensureConnected();
    const next = new MemoryService(memoryConfig({ enabled: true }), () => {}, home); next.provider = lifecycle;
    assert.deepEqual(await readdir(path.join(home, "memory-pending")), [file]);
    await next.flush(); // drain: idempotent replay, no conflict, no duplicate
    assert.deepEqual(await readdir(path.join(home, "memory-pending")), []);
    assert.equal((await store.status()).entries, 1);
    // Worker continuity: its own handoff stays recallable for the worker.
    assert.match(await next.recall(worker, "unrelated"), /found queue hold/);
    // Explicit lesson by the worker lands in the owner scope with its source preserved.
    const lesson = await lifecycle.put({ sessionKey: worker }, { key: "lesson-1", kind: "lesson", title: "Queue hold", text: "Dispatcher queue hold is not an outage", source: "dispatch:exec1 diagnosis" });
    assert.equal(lesson.sessionKey, owner); assert.equal(lesson.source, "dispatch:exec1 diagnosis");
    // Replay of the explicit write is idempotent as well.
    assert.equal((await lifecycle.put({ sessionKey: worker }, { key: "lesson-1", kind: "lesson", title: "Queue hold", text: "Dispatcher queue hold is not an outage", source: "dispatch:exec1 diagnosis" })).id, lesson.id);
    // Owner recall sees the lesson, not the worker's routine turn record.
    const ownerHits = await lifecycle.search({ sessionKey: owner }, "dispatcher queue hold");
    assert.deepEqual(ownerHits.map(h => h.entry.id), [lesson.id]);
    // Worker sees both its own record and the owner's lesson; revise/forget work through the owner.
    const workerHits = await lifecycle.search({ sessionKey: worker }, "dispatcher queue hold");
    assert.equal(workerHits.length, 2);
    const revised = await lifecycle.revise({ sessionKey: worker }, lesson.id, lesson.revision, { text: "Queue hold is a capacity state" });
    assert.equal(revised.sessionKey, owner);
    // Other conversations and orphan workers stay isolated.
    for (const key of ["matrix:!other", "dispatch:orphan:tok"]) assert.equal((await lifecycle.search({ sessionKey: key }, "dispatcher queue hold")).length, 0, key);
    assert.equal(await lifecycle.get({ sessionKey: "matrix:!other" }, lesson.id), undefined);
    await lifecycle.close();
  } finally { await store.close?.(); await rm(home, { recursive: true, force: true }); }
});
