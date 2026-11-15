import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness, type DurableTask } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

test("exhausted scheduled occurrence is held without closing it or affecting a later occurrence", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scheduled-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const key = "mem:room1", original = "Outside the reporting window reply NO_REPLY";
  const ref = await store.enrollTask(key, "first", original, "first", "schedule");
  const next = await store.enrollTask(key, "second", original, "second", "schedule");
  let checks = 0;
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, executionStore: store, taskLifecycle: { enabled: true },
    completionCheck: async () => { checks++; return undefined; } });
  const task: DurableTask = { id: "first", original, taskRef: ref, state: "active", depth: 0,
    recoveryAssessment: "decided", recoveryRetry: { attempts: 6, nextAt: 0, diagnostic: "inconclusive" } };
  h.restoreSessions([{ key, task }]); h.onStateChange = async () => {};
  try {
    await h.recoverTasks(); await h.recoverTasks();
    const saved = h.snapshotSessions()[0]!.task!;
    assert.equal(checks, 0); assert.equal(runtime.opened.length, 0);
    assert.equal(saved.state, "blocked"); assert.equal(saved.termination, "recovery_assessment_failed");
    assert.equal(saved.recoveryRetry?.attempts, 6);
    assert.equal(store.coreTask(ref.id)!.operatorStatus, "open");
    assert.equal(store.coreTask(next.id)!.operatorStatus, "open");
    const reloaded = new Harness({ runtime: new FakeRuntime(), executionStore: store, taskLifecycle: { enabled: true }, completionCheck: async () => { checks++; return undefined; } });
    reloaded.restoreSessions(JSON.parse(JSON.stringify(h.snapshotSessions()))); reloaded.onStateChange = async () => {};
    try { await reloaded.recoverTasks(); assert.equal(checks, 0); assert.equal(reloaded.state(key).task!.state, "blocked"); }
    finally { await reloaded.stop(0); }
  } finally { await h.stop(0); }
});
