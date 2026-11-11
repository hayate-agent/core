import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore, type WaitAuthorityDenialReason } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { toolGuardDenialReason } from "../src/tool-guard-error.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

for (const reason of ["ownership", "cancelled", "deadline", "missing-task", "stopped-task", "sequence", "invalid-deadline", "valid"] as const) {
  test(`wait guard receipt: ${reason}`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wait-denial-"));
    const file = path.join(dir, "executions.json");
    const store = new ExecutionStore(file); await store.load();
    let now = 61000;
    const runtime = new FakeRuntime(); const open = runtime.open.bind(runtime);
    let checked = false;
    const h = new Harness({ runtime, now: () => now, executionStore: store });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    h.restoreSessions([{ key: "mem:room1", task: { id: "task", original: "SECRET original", state: "waiting",
      next: "SECRET next", depth: 2, expiresAt: 301000, wait: { reason: "SECRET dependency", nextAt: 61000, deadline: 301000 } } }]);
    runtime.open = async (...args) => {
      const session = await open(...args);
      session.prompt = async () => {
        const s = h.state("mem:room1"); const input = s.current!; const task = s.task!;
        h.onStateChange = async () => {
          if (reason === "ownership") s.current = { ...input };
          if (reason === "cancelled") s.cancelling = input;
          if (reason === "deadline") now = 301000;
          if (reason === "invalid-deadline") input.continuationExpiresAt = undefined;
          if (reason === "missing-task") { s.tasks = []; s.task = undefined; }
          if (reason === "stopped-task") task.state = "stopped";
          if (reason === "sequence") task.waitChecks!++;
        };
        let effects = 0;
        try {
          await h.guardWaitTool("mem:room1", "bash", { command: "SECRET arguments" }); effects++;
          assert.equal(reason, "valid");
        } catch (error) {
          assert.notEqual(reason, "valid");
          const code = reason === "ownership" || reason === "sequence" ? "ownership_lost" :
            reason === "cancelled" || reason === "stopped-task" ? "execution_cancelled" :
            reason === "deadline" ? "deadline_expired" : reason === "invalid-deadline" ? "authority_revoked" : "parent_mandate_missing";
          assert.match(toolGuardDenialReason(error), new RegExp(`^${code}:`));
          assert.doesNotMatch(toolGuardDenialReason(error), /SECRET|sequence/);
        }
        assert.equal(effects, reason === "valid" ? 1 : 0);
        const receipts = store.waitAuthorityDenials();
        assert.equal(receipts.length, reason === "valid" ? 0 : 1);
        if (reason !== "valid") {
          assert.deepEqual(receipts[0], { reason: reason === "invalid-deadline" ? "deadline" : reason, at: now, taskId: "task", waitSequence: 1,
            taskWaitSequence: reason === "missing-task" ? undefined : reason === "sequence" ? 2 : 1,
            turnId: input.executionTurnId });
          // Even checkpoint/status exemptions must pass the authority gate.
          if (reason !== "ownership") for (const tool of ["plugin_task_continuation", "plugin_dispatch"]) {
            await assert.rejects(h.guardWaitTool("mem:room1", tool, { action: "status", text: "SECRET" }),
              /Wait task authority revoked/);
          }
        } else {
          await h.guardWaitTool("mem:room1", "plugin_task_continuation", {});
          await h.guardWaitTool("mem:room1", "plugin_dispatch", { action: "status" });
        }
        s.current = input; s.cancelling = undefined;
        h.onStateChange = async () => {};
        checked = true; return "NO_REPLY";
      }; return session;
    };
    try {
      await h.tick(); await h.drained(); assert.ok(checked);
      const reloaded = new ExecutionStore(file); await reloaded.load();
      assert.deepEqual(reloaded.waitAuthorityDenials(), JSON.parse(JSON.stringify(store.waitAuthorityDenials())));
      assert.doesNotMatch(JSON.stringify(store.waitAuthorityDenials()), /SECRET|command|arguments/);
    } finally { await h.stop(0); await rm(dir, { recursive: true, force: true }); }
  });
}

test("receipt retention is capped, projected, reloadable and not an outgoing event", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wait-ring-"));
  try {
    const file = path.join(dir, "ledger.json"); const store = new ExecutionStore(file); await store.load();
    for (let at = 0; at < 105; at++) await store.recordWaitAuthorityDenial({ reason: "deadline" as WaitAuthorityDenialReason,
      at, waitSequence: 1, taskId: "t".repeat(200), ...{ arguments: "SECRET", error: "SECRET" } });
    assert.equal(store.waitAuthorityDenials().length, 100);
    assert.equal(store.waitAuthorityDenials()[0].at, 5);
    assert.equal(store.waitAuthorityDenials()[0].taskId!.length, 128);
    const clone = store.waitAuthorityDenials(); clone.pop(); assert.equal(store.waitAuthorityDenials().length, 100);
    assert.deepEqual(store.events(), []);
    assert.doesNotMatch(await readFile(file, "utf8"), /SECRET|arguments|error/);
    const reload = new ExecutionStore(file); await reload.load(); assert.equal(reload.waitAuthorityDenials().length, 100);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
