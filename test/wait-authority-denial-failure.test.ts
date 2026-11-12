import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import { toolGuardDenialReason } from "../src/tool-guard-error.js";

test("receipt storage failure cannot authorize a tool or leak exception text", async () => {
  const runtime = new FakeRuntime(); const open = runtime.open.bind(runtime);
  const dir = await mkdtemp(path.join(os.tmpdir(), "wait-failure-"));
  const store = new ExecutionStore(path.join(dir, "ledger.json")); await store.load();
  store.recordWaitAuthorityDenial = async () => { throw Error("SECRET disk path and credentials"); };
  const logs: string[] = []; let checked = false;
  const h = new Harness({ runtime, executionStore: store, now: () => 61000, log: text => logs.push(text) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", task: { id: "task", original: "authorized", state: "waiting", depth: 1,
    next: "check", wait: { reason: "dependency", nextAt: 61000, deadline: 301000 } } }]);
  runtime.open = async (...args) => {
    const session = await open(...args);
    session.prompt = async () => {
      const s = h.state("mem:room1"); s.cancelling = s.current;
      for (const tool of ["bash", "plugin_task_continuation", "plugin_dispatch"]) {
        await assert.rejects(h.guardWaitTool("mem:room1", tool, { action: "status", command: "SECRET" }), error => {
          assert.match(toolGuardDenialReason(error)!, /^execution_cancelled:/);
          assert.doesNotMatch(String(error), /SECRET/); return true;
        });
      }
      s.cancelling = undefined; checked = true; return "NO_REPLY";
    }; return session;
  };
  try {
    await h.tick(); await h.drained(); assert.ok(checked);
    assert.equal(logs.filter(text => text === "wait authority denial receipt persistence failed").length, 3);
    assert.doesNotMatch(logs.join("\n"), /SECRET/);
  } finally { await h.stop(0); await rm(dir, { recursive: true, force: true }); }
});
