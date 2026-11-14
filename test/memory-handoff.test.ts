import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryService } from "../src/builtin-plugins/memory-service.js";
import { FileMemoryStore } from "../src/memory-worker.js";
import { memoryConfig, type MemoryTurn, type MemoryWrite } from "../src/memory.js";

const config = memoryConfig({ enabled: true, recallLimit: 1 });
const sessionKey = "matrix:handoff-one";
const turn: MemoryTurn = { id: "turn-1", sessionKey, text: "Remember the rollout decision", reply: "Keep Hermes running. The rollout is not verified.", outcome: "completed", tools: 0, recordedAt: 1800000000000 };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const entries = (recall: string) => recall ? JSON.parse(recall.slice(recall.indexOf("\n", 1) + 1)) : [];

async function setup(t: any) {
  const home = await mkdtemp(path.join(os.tmpdir(), "hayate-handoff-"));
  const stores: FileMemoryStore[] = [];
  async function open() {
    const store = new FileMemoryStore(home, config);
    await store.start(); stores.push(store); return store;
  }
  const store = await open();
  const service = new MemoryService(config, () => {}, home); service.provider = store;
  t.after(async () => { for (const s of stores) await s.close(); await rm(home, { recursive: true, force: true }); });
  return { home, store, service, open };
}

test("completed no-tool handoff is recalled first after its background persistence barrier, independent of search terms", async (t) => {
  const { service, store } = await setup(t);
  await service.capture(turn);
  // Test setup waits for background persistence; production recall must never flush.
  await service.flush();
  const recalled = entries(await service.recall(sessionKey, "unrelated astronomy"));
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].latestHandoff, true);
  assert.equal(recalled[0].verification, "reported");
  assert.match(recalled[0].text, /Keep Hermes running/);
  assert.match(recalled[0].text, /task completion and next steps are not inferred/);
  assert.match(recalled[0].text, /Turn reference: turn-1/);
  assert.equal((await store.status()).entries, 1);
});

test("provider and service restart retain a scope-isolated latest handoff; replay stays idempotent", async (t) => {
  const { home, service, store, open } = await setup(t);
  await service.capture(turn); await service.flush();
  const first = entries(await service.recall(sessionKey, "unrelated"))[0];
  const before = await store.get({ sessionKey }, first.id);
  await store.close();
  const reopened = await open();
  const next = new MemoryService(config, () => {}, home); next.provider = reopened;
  assert.equal(entries(await next.recall(sessionKey, "another unrelated query"))[0].id, first.id);
  assert.equal(await next.recall("matrix:handoff-two", "Keep Hermes running"), "");
  await next.capture(turn); await next.flush();
  assert.equal((await reopened.status()).entries, 1);
  assert.deepEqual(await reopened.get({ sessionKey }, first.id), before);
  await next.capture({ ...turn, sessionKey: "matrix:handoff-two", reply: "Other isolated result" }); await next.flush();
  assert.match(entries(await next.recall("matrix:handoff-two", "unrelated"))[0].text, /Other isolated result/);
  assert.equal(entries(await next.recall(sessionKey, "Other isolated result"))[0].id, first.id);
});

test("older captures and replays never replace a newer handoff pointer", async (t) => {
  const { service } = await setup(t);
  await service.capture({ ...turn, id: "newer", reply: "Latest result", recordedAt: turn.recordedAt! + 100 }); await service.flush();
  const latest = entries(await service.recall(sessionKey, "unrelated"))[0];
  await service.capture(turn); await service.flush();
  assert.equal(entries(await service.recall(sessionKey, "unrelated"))[0].id, latest.id);
});

test("failed capture retains legacy pending bytes unchanged and cannot publish a false completion", async (t) => {
  const { home, store } = await setup(t);
  const dir = path.join(home, "memory-pending"); await mkdir(dir, { recursive: true });
  const legacy: MemoryWrite = { key: "turn-retained-v2:legacy", title: "Old pending payload", text: "Legacy claim", source: "legacy", expiresAt: "2099-01-01T00:00:00.000Z" };
  const file = path.join(dir, hash(legacy.key) + ".json");
  const original = JSON.stringify({ sessionKey, entry: legacy }, null, 2);
  await writeFile(file, original);
  const service = new MemoryService(config, () => {}, home);
  const put = store.put.bind(store);
  store.put = async () => { throw Error("provider offline"); }; service.provider = store;
  await service.capture({ ...turn, outcome: "failed", reply: "Repair remains incomplete" }); await service.flush();
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal((await readdir(dir)).length, 2);
  assert.equal(await service.recall(sessionKey, "unrelated"), "");
  await assert.rejects(readFile(path.join(home, "memory-latest", hash(sessionKey) + ".json")), /ENOENT/);
  store.put = async (ctx, entry) => { if (entry.key === legacy.key) assert.deepEqual(entry, legacy); return put(ctx, entry); };
  const restarted = new MemoryService(config, () => {}, home); restarted.provider = store;
  await restarted.flush(); // Explicit recovery barrier, not a foreground recall side effect.
  const recalled = entries(await restarted.recall(sessionKey, "unrelated"));
  assert.match(recalled[0].text, /Outcome reported by Hayate Agent: failed/);
  assert.match(recalled[0].text, /Turn did not complete successfully/);
  assert.match(recalled[0].text, /Repair remains incomplete/);
  assert.equal((await readdir(dir)).length, 0);
  assert.equal((await store.search({ sessionKey }, "Legacy claim"))[0].entry.expiresAt, legacy.expiresAt);
});

test("meaningful NO_REPLY and empty failure turns persist without fabricating a result", async (t) => {
  const { service } = await setup(t);
  for (const [index, reply] of ["NO_REPLY", ""].entries()) {
    await service.capture({ ...turn, id: `silent-${index}`, reply, outcome: "failed", recordedAt: turn.recordedAt! + index }); await service.flush();
    const item = entries(await service.recall(sessionKey, "unrelated"))[0];
    assert.match(item.text, /No visible reply; no result inferred/);
    assert.match(item.text, /Turn did not complete successfully/);
  }
});

test("revoked or expired pointer targets cannot be recalled as the latest handoff", async (t) => {
  const { service, store } = await setup(t);
  await service.capture(turn); await service.flush();
  const first = entries(await service.recall(sessionKey, "unrelated"))[0];
  const entry = (await store.get({ sessionKey }, first.id))!;
  const revoked = await store.revise({ sessionKey }, entry.id, entry.revision, { state: "revoked" });
  assert.equal(await service.recall(sessionKey, "unrelated"), "");
  await store.revise({ sessionKey }, entry.id, revoked.revision, { state: "active", expiresAt: "2000-01-01T00:00:00.000Z" });
  assert.equal(await service.recall(sessionKey, "unrelated"), "");
});

test("latest handoff survives semantic search failure and remains bounded valid JSON", async (t) => {
  const { home, store } = await setup(t);
  const service = new MemoryService(memoryConfig({ enabled: true }), () => {}, home); service.provider = store;
  await service.capture({ ...turn, text: "\u0000".repeat(10000), reply: "\u0001".repeat(10000) }); await service.flush();
  store.search = async () => { throw Error("search unavailable"); };
  const recall = await service.recall(sessionKey, "unrelated");
  assert.ok(recall.length < 12300);
  assert.equal(entries(recall)[0].latestHandoff, true);
});

test("without a home, provider-persisted replay is stable even when host timestamp is absent", async (t) => {
  const { store } = await setup(t);
  const service = new MemoryService(config, () => {}); service.provider = store;
  const noTimestamp = { ...turn, recordedAt: undefined };
  await service.capture(noTimestamp); await service.capture(noTimestamp);
  assert.equal((await store.status()).entries, 1);
  const recalled = entries(await service.recall(sessionKey, "unrelated"))[0];
  assert.equal(recalled.latestHandoff, true);
  const entry = (await store.get({ sessionKey }, recalled.id))!;
  assert.equal(entry.reviewAfter, "1970-01-01T00:00:00.000Z", "unknown time remains unknown: fixed epoch, never a fresh wall-clock claim");
});
