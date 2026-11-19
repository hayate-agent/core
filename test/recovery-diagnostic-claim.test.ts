import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime } from "./fakes.js";

test("independent dependency assessment claim preserves prior diagnostic and child fence", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "recovery-diagnostic-"));
  const store = new ExecutionStore(path.join(home, "executions.json"));
  await store.load();
  const child = await store.submit("mem:room1", "child", "edit", "direct", 1,
    { taskId: "parent", depth: 0, original: "Fix and document" });
  const claim = await store.claim(child.id);
  await store.intent(child.id, claim.token!, "edit", "unsafe");
  await store.fail(child.id, claim.token!, "runtime-failure");
  const detail = { cause: "uncertain" as const, reason: "Prior low confidence" };
  let saved: ReturnType<Harness["snapshotSessions"]> | undefined;
  const h = new Harness({ runtime: new FakeRuntime(), executionStore: store, now: () => 1000,
    completionCheck: async () => {
      assert.deepEqual(saved?.[0]?.task?.recoveryRetry?.detail, detail);
      throw Error("assessor interrupted");
    } });
  h.restoreSessions([{ key: "mem:room1", task: { id: "parent", original: "Fix and document", state: "blocked", depth: 0,
    recoveryRetry: { attempts: 2, nextAt: 1, diagnostic: "inconclusive", detail },
    supervisorDecision: { verdict: "blocked", diagnostic: "inconclusive", dependencyHold: { evidence: "old", reason: "global-hold" } } } }]);
  h.onStateChange = async () => {
    const snapshot = structuredClone(h.snapshotSessions());
    if (snapshot[0]?.task?.supervisorDecision?.dependencyHold?.reason === "assessment-claimed") saved = snapshot;
  };
  try {
    await h.recoverTasks();
    assert.equal(saved?.[0]?.task?.recoveryRetry?.attempts, 3);
    assert.equal(saved?.[0]?.task?.recoveryRetry?.diagnostic, "inconclusive");
    assert.deepEqual(saved?.[0]?.task?.recoveryRetry?.detail, detail);
    assert.equal(saved?.[0]?.task?.recoveryAdmission, undefined);
    assert.equal(store.list()[0]?.status, "blocked");
    assert.equal(store.list()[0]?.intent?.key, "edit");
  } finally { await h.stop(0); await rm(home, { recursive: true, force: true }); }
});
