// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExecutionStore } from "../src/execution.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "recovery-review-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const open = async () => { const s = new ExecutionStore(path.join(home, "ledger.json")); await s.load(); return s; };
  return { open, store: await open() };
}
const strategy = { version: 1, replaySafe: false };
const strategies = new Map([["direct", strategy]]);

test("resolution survives reopen but is consumed by exactly one claim", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  const first = await f.store.claim(task.id);
  await f.store.intent(task.id, first.token!, "effect", "unsafe");
  let s = await f.open(); await s.recover(strategies);
  await s.resolve("p", task.id, "operator", "retry", "checked prior effect");
  s = await f.open(); await s.recover(strategies); await s.recover(strategies);
  const strict = { name: "strict", evaluate: () => "new assessment required" };
  const retry = await s.claim(task.id, { strategy: "direct", ...strategy }, strict);
  assert.equal(retry.recoveryGrant, undefined);
  assert.equal(retry.claimedRecoveryAction, "retry");
  assert.equal(s.list()[0]!.claimedRecoveryAction, undefined);
  assert.equal(retry.resolutions?.length, 1);
  s = await f.open(); await s.recover(strategies, undefined, strict);
  assert.equal(s.list()[0]!.status, "blocked");
  assert.equal(s.list()[0]!.recoveryReason, "new assessment required");
});

test("explicit restart limit enforced while omitted limit remains permissive", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  for (let i = 0; i < 5; i++) {
    await f.store.claim(task.id);
    await f.store.recover(strategies);
    assert.equal(f.store.list()[0]!.status, "ready");
  }
  await f.store.claim(task.id);
  await f.store.recover(strategies, 6);
  assert.equal(f.store.list()[0]!.status, "blocked");
  assert.match(f.store.list()[0]!.recoveryReason!, /restart limit 6/);
});

test("crash after replacement claim retains registered transcript until worker registration", async t => {
  const f = await fixture(t);
  const task = await f.store.submit("p", "r", "work", "direct");
  const first = await f.store.claim(task.id);
  const original = `dispatch:${task.id}:${first.token}`;
  await f.store.workerSession(task.id, first.token!, original);
  await f.store.intent(task.id, first.token!, "effect", "unsafe");
  const reconciling = new Map([["direct", { ...strategy, reconcile: true }]]);
  await f.store.recover(reconciling);
  const second = await f.store.claim(task.id, { strategy: "direct", ...strategy, reconcile: true });
  let s = await f.open(); await s.recover(reconciling);
  assert.equal(s.list()[0]!.recoverySession, original);
  await assert.rejects(s.workerSession(task.id, second.token!, `dispatch:${task.id}:${second.token}`), /Stale/);
  const third = await s.claim(task.id, { strategy: "direct", ...strategy, reconcile: true });
  const replacement = `dispatch:${task.id}:${third.token}`;
  await s.workerSession(task.id, third.token!, replacement);
  s = await f.open();
  assert.equal(s.list()[0]!.recoverySession, replacement);
});
