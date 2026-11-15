import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

test("silent scheduler results are durable per occurrence without deciding completion", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "silent-evidence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json"), store = new ExecutionStore(file); await store.load();
  const runtime = new FakeRuntime(); runtime.answer = () => "NO_REPLY";
  const h = new Harness({ runtime, executionStore: store, taskLifecycle: { enabled: true }, completionCheck: async () => undefined });
  h.onStateChange = async () => {};
  try {
    for (const id of ["first", "second"]) { await h.submit({ id, sessionKey: "cron:hourly", source: "cron", text: "Return NO_REPLY" }); await h.drained(); }
    const first = store.taskBinding("cron:hourly", "first")!, second = store.taskBinding("cron:hourly", "second")!;
    assert.notEqual(first.id, second.id);
    for (const ref of [first, second]) {
      const order = store.coreTask(ref.id)!;
      assert.equal(order.operatorStatus, "open");
      assert.equal(order.receipts.filter(r => r.kind === "scheduled-silence" && r.reason === "NO_REPLY").length, 1);
    }
    const reload = new ExecutionStore(file); await reload.load();
    assert.equal(reload.coreTask(first.id)!.receipts.filter(r => r.kind === "scheduled-silence").length, 1);
    assert.equal(reload.coreTask(second.id)!.receipts.filter(r => r.kind === "scheduled-silence").length, 1);
  } finally { await h.stop(0); }
});

test("silence provenance cannot cross occurrences or bypass cancellation", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "silent-boundary-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const a = await store.enrollTask("cron:a", "a", "A", "a", "schedule");
  const b = await store.enrollTask("cron:a", "b", "B", "b", "schedule");
  await store.beginTurn("bad", "cron:a");
  await assert.rejects(store.settleTurn("bad", "cron:a", { outbox: [], consumed: [], scheduledSilence: { taskId: "a", ref: b } }), /provenance/);
  await store.beginTurn("stopped", "cron:a"); await store.stopTurn("stopped", "cron:a");
  await store.settleTurn("stopped", "cron:a", { outbox: [], consumed: [], scheduledSilence: { taskId: "a", ref: a } });
  assert.equal(store.coreTask(a.id)!.receipts.some(r => r.kind === "scheduled-silence"), false);
});
