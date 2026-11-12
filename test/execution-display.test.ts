import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { TurnActivity, type ActivityEvent } from "../src/activity.js";
import { executionMetadata, executionLabel } from "../src/builtin-plugins/execution-metadata.js";

test("selection display is bounded, plain and explicitly unknown", () => {
  assert.match(executionLabel(), /unknown\/pending/);
  const value = executionMetadata({ model: "\x1b[31m<b>" + "x".repeat(500), thinking: "high\n**" });
  assert.equal(value.model?.length, 160);
  assert.equal(value.thinking, "high");
  assert.doesNotMatch(executionLabel(value), /[<>\x1b\n*]/);
});

test("Main and Worker activity retain selection independently of usage and stop after finish", () => {
  for (const role of ["main", "worker", "dispatcher-classifier"] as const) {
    const events: ActivityEvent[] = [];
    const activity = new TurnActivity({ id: role, role, context: "operator" }, e => events.push(e));
    assert.equal(events[0].snapshot.execution, undefined);
    activity.event({ type: "execution", selection: { model: "p/b", thinking: "off" } });
    activity.event({ type: "usage", model: "reported/other", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
    activity.finish("cancelled");
    assert.deepEqual(events.at(-1)?.snapshot.execution, { model: "p/b", thinking: "off" });
    const count = events.length;
    activity.event({ type: "execution", selection: { model: "late" } });
    assert.equal(events.length, count);
  }
});

test("worker observation persists on restart, is token scoped, and a new claim clears it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "execution-display-"));
  try {
    const file = path.join(dir, "executions.json"); const store = new ExecutionStore(file); await store.load();
    const task = await store.submit("parent", "request", "task", "direct");
    const running = await store.claim(task.id);
    await store.observeExecution(task.id, running.token!, { model: "p/b", thinking: "off" });
    await store.observeClassifier(task.id, running.token!, { model: "p/wanted", thinking: "high" }, { model: "p/inherited", thinking: "off" });
    await assert.rejects(store.observeClassifier(task.id, "stale", { model: "bad" }));
    await assert.rejects(store.observeExecution(task.id, "stale", { model: "bad" }));
    const fresh = new ExecutionStore(file); await fresh.load();
    assert.deepEqual(fresh.list("parent")[0].execution, { model: "p/b", thinking: "off" });
    assert.deepEqual(fresh.list()[0].classifier, { requested: { model: "p/wanted", thinking: "high" }, actual: { model: "p/inherited", thinking: "off" } });
    await fresh.control(task.id, "pause");
    await assert.rejects(fresh.observeClassifier(task.id, running.token!, { model: "bad" }));
    await assert.rejects(fresh.observeExecution(task.id, running.token!, { model: "bad" }));
    await fresh.control(task.id, "resume");
    const next = await fresh.claim(task.id);
    assert.equal(next.execution, undefined);
    assert.equal(next.classifier, undefined);
    await assert.rejects(fresh.observeExecution(task.id, running.token!, { model: "bad" }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
