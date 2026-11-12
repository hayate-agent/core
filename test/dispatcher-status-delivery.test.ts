import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";

test("failed status delivery cannot abort execution and durable events remain retryable", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-status-"));
  const store = new ExecutionStore(path.join(home, "ledger.json"));
  await store.load();
  let unavailable = true;
  let effects = 0;
  const delivered: string[] = [];
  const dispatcher = new Dispatcher(store, {
    name: "direct", version: 1, replaySafe: false,
    execute: async (_task, context) => {
      await context.checkpoint("plan retained");
      await context.status("plan ready");
      effects++;
      return "391";
    },
  }, 1, async event => {
    if (unavailable) throw Error("HTTP 429");
    delivered.push(event.id);
  }, () => {});
  t.after(async () => { await dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  await dispatcher.start();
  const task = await dispatcher.submit("parent", "request", "17 times 23");
  for (let i = 0; i < 200 && store.list()[0]?.status !== "completed"; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(store.list()[0]?.status, "completed");
  assert.equal(store.list()[0]?.result, "391");
  assert.equal(effects, 1);
  assert.ok(store.events().length > 0);
  unavailable = false;
  await dispatcher.flushEvents();
  assert.equal(store.events().length, 0);
  assert.equal(effects, 1, "delivery retry must never replay work");
  assert.equal(new Set(delivered).size, delivered.length);
  assert.equal(store.list()[0]?.id, task.id);
});
