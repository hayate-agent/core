// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExecutionStore } from "../src/execution.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "execution-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file);
  await store.load();
  return { store, reopen: async () => { const fresh = new ExecutionStore(file); await fresh.load(); return fresh; } };
}

test("load rejects malformed effect markers before recovery", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "execution-invalid-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.json");
  const record = { id: "x", parent: "p", requestId: "r", input: "work", strategy: "direct", strategyVersion: 1, status: "running", restarts: 0 };
  for (const invalid of [
    { settledEffect: null }, { settledEffect: { key: "turn:x", result: 42 } },
    { settledEffect: { key: "", result: "ok" } }, { intent: null },
    { intent: { key: "effect", replay: "sure" } }, { checkpoint: {} },
    { claimedRecoveryAction: "retry" }, { recoveryGrant: { action: "retry", restarts: -1 } },
  ]) {
    await writeFile(file, JSON.stringify({ version: 1, executions: [{ ...record, ...invalid }], events: [] }));
    await assert.rejects(new ExecutionStore(file).load(), /Invalid/);
  }
});

test("submission is durable and deduplicates only identical requests", async t => {
  const f = await fixture(t);
  const first = await f.store.submit("parent", "message", "do work", "direct");
  const fresh = await f.reopen();
  assert.equal((await fresh.submit("parent", "message", "do work", "direct")).id, first.id);
  await assert.rejects(fresh.submit("parent", "message", "other work", "direct"), /Conflicting/);
  assert.equal(fresh.events().length, 1);
});

test("claims serialize and stale workers cannot commit after recovery", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  const claims = await Promise.allSettled([f.store.claim(task.id), f.store.claim(task.id)]);
  assert.equal(claims.filter(c => c.status === "fulfilled").length, 1);
  const old = f.store.list()[0]!;
  const fresh = await f.reopen();
  await fresh.recover(new Map([["direct", { version: 1, replaySafe: false }]]));
  await assert.rejects(fresh.complete(task.id, old.token!, "late"), /Stale/);
  const next = await fresh.claim(task.id);
  assert.notEqual(next.token, old.token);
  await fresh.complete(task.id, next.token!, "done");
  const restored = await f.reopen();
  assert.equal(restored.list()[0]!.status, "completed");
  assert.equal(restored.events().filter(e => e.type === "result").length, 1);
});

test("unresolved unsafe effect blocks recovery", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  const running = await f.store.claim(task.id);
  await f.store.intent(task.id, running.token!, "create-pr", "unsafe");
  const fresh = await f.reopen();
  await fresh.recover(new Map([["direct", { version: 1, replaySafe: true }]]));
  assert.equal(fresh.list()[0]!.status, "blocked");
  await fresh.control(task.id, "pause");
  assert.equal(fresh.list()[0]!.status, "blocked");
  await assert.rejects(fresh.control(task.id, "resume"), /blocker/);
  await assert.rejects(fresh.claim(task.id), /not ready/);
});

test("safe recovery requires matching current policy and can settle before completion", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  const old = await f.store.claim(task.id);
  await f.store.intent(task.id, old.token!, "read", "safe");
  const fresh = await f.reopen();
  await fresh.recover(new Map([["direct", { version: 1, replaySafe: true }]]));
  assert.equal(fresh.list()[0]!.status, "ready");
  for (const policy of [undefined,
    { strategy: "direct", version: 1, replaySafe: false },
    { strategy: "other", version: 1, replaySafe: true },
    { strategy: "direct", version: 2, replaySafe: true }]) {
    await assert.rejects(fresh.claim(task.id, policy), /Strategy .* unavailable|Uncertain effect/);
    assert.equal(fresh.list()[0]!.status, "ready");
  }
  const running = await fresh.claim(task.id, { strategy: "direct", version: 1, replaySafe: true });
  assert.equal(running.intent?.key, "read");
  await assert.rejects(fresh.settleIntent(task.id, old.token!, "read", "old", "old"), /Stale/);
  await fresh.settleIntent(task.id, running.token!, "read", "read result", "next step");
  await fresh.complete(task.id, running.token!, "done");
  assert.equal((await f.reopen()).list()[0]!.status, "completed");
});

test("unknown strategy versions do not execute", async t => {
  const f = await fixture(t);
  await f.store.submit("p", "r", "work", "direct", 1);
  await f.store.recover(new Map([["direct", { version: 2, replaySafe: true }]]));
  assert.equal(f.store.list()[0]!.status, "blocked");
});

test("pause during an effect blocks execution and revokes the old claim", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  const running = await f.store.claim(task.id);
  await f.store.intent(task.id, running.token!, "external-action", "unsafe");
  await f.store.control(task.id, "pause");
  assert.equal(f.store.list()[0]!.status, "blocked");
  await assert.rejects(f.store.control(task.id, "resume"), /blocker/);
  await assert.rejects(f.store.claim(task.id), /not ready/);
  await assert.rejects(f.store.checkpoint(task.id, running.token!, "late"), /Stale/);
  assert.equal((await f.reopen()).list()[0]!.status, "blocked");
});

test("pause does not clear missing strategy or restart-limit blockers", async t => {
  const f = await fixture(t);
  const missing = await f.store.submit("p", "missing", "work", "absent");
  const crashing = await f.store.submit("p", "crashing", "work", "direct");
  await f.store.claim(crashing.id);
  await f.store.recover(new Map([["direct", { version: 1, replaySafe: false }]]), 1);
  for (const task of [missing, crashing]) {
    await f.store.control(task.id, "pause");
    assert.equal(f.store.list().find(item => item.id === task.id)!.status, "blocked");
    await assert.rejects(f.store.control(task.id, "resume"), /blocker/);
    await assert.rejects(f.store.claim(task.id), /not ready/);
  }
});

test("ordinary pause and resume allow a fresh claim but reject the old worker", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  const old = await f.store.claim(task.id);
  await f.store.control(task.id, "pause");
  await f.store.control(task.id, "resume");
  const next = await f.store.claim(task.id);
  assert.notEqual(next.token, old.token);
  await assert.rejects(f.store.complete(task.id, old.token!, "late"), /Stale/);
  await f.store.complete(task.id, next.token!, "done");
});

test("result event persists until explicit acknowledgement", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  const running = await f.store.claim(task.id);
  await f.store.complete(task.id, running.token!, "answer");
  const event = f.store.events().find(e => e.type === "result")!;
  const fresh = await f.reopen();
  assert.ok(fresh.events().some(e => e.id === event.id));
  await fresh.ack(event.id);
  assert.ok(!(await f.reopen()).events().some(e => e.id === event.id));
});
