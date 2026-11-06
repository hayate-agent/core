// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";

test("archive removes only delivered old terminals, preserves request deduplication across restart", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "execution-archive-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.json");
  let now = 1000; const protectedIds = new Set<string>();
  const store = new ExecutionStore(file, { now: () => now, protectedExecutions: () => protectedIds }); await store.load();
  const task = await store.submit("parent", "request", "work", "direct");
  const claimed = await store.claim(task.id); await store.complete(task.id, claimed.token!, "evidence");
  now += 8 * 86400000;
  assert.equal(await store.compact(), 0); // result not acknowledged
  for (const event of store.events()) await store.ack(event.id);
  protectedIds.add(task.id);
  assert.equal(await store.compact(), 0); // durable host inbox still needs authority
  protectedIds.clear();
  assert.equal(await store.compact(), 1);
  assert.equal(store.list().length, 0);
  assert.equal((await readdir(`${file}.archive`)).length, 1);
  const reopened = new ExecutionStore(file); await reopened.load();
  const retry = await reopened.submit("parent", "request", "work", "direct");
  assert.equal(retry.id, task.id); assert.equal(retry.result, "evidence");
  assert.equal(reopened.list().length, 0);
  await assert.rejects(reopened.submit("parent", "request", "different", "direct"), /Conflicting/);
  assert.notEqual((await reopened.submit("other-parent", "request", "work", "direct")).id, task.id);
});

test("retention age and unresolved effects are not bypassed; archive write failure retains task", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "execution-archive-failure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "ledger.json");
  const store = new ExecutionStore(file, { now: () => 1000 }); await store.load();
  const complete = await store.submit("p", "complete", "work", "direct");
  const claimed = await store.claim(complete.id); await store.complete(complete.id, claimed.token!, "done");
  const unsafe = await store.submit("p", "unsafe", "work", "direct");
  const running = await store.claim(unsafe.id); await store.intent(unsafe.id, running.token!, "effect", "unsafe");
  await store.control(unsafe.id, "cancel");
  for (const event of store.events()) await store.ack(event.id);
  assert.equal(await store.compact(), 0);
  assert.equal(await store.compact("other", 0), 0);
  // Force atomic archive replacement to fail without modifying the live ledger.
  const { createHash } = await import("node:crypto");
  const key = createHash("sha256").update(JSON.stringify(["p", "complete"])).digest("hex");
  await mkdir(path.join(`${file}.archive`, `${key}.json`), { recursive: true });
  await assert.rejects(store.compact("p", 0));
  assert.equal(store.list().length, 2);
  await rm(path.join(`${file}.archive`, `${key}.json`), { recursive: true });
  assert.equal(await store.compact("p", 0), 1);
  assert.equal(store.list()[0]!.id, unsafe.id);
});
