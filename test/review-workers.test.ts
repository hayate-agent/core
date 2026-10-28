import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewWorkers } from "../src/review-execution.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime } from "./fakes.js";

test("cancel drains the actual worker before the execution rejects", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-worker-cancel-"));
  const runtime = new FakeRuntime(); const open = runtime.open.bind(runtime);
  let disposed = false;
  runtime.open = async (key, options) => {
    const session = await open(key, options); runtime.sessions.get(key)!.hold();
    session.dispose = () => { disposed = true; }; return session;
  };
  const store = new ExecutionStore(path.join(home, "executions.json"));
  const workers = new ReviewWorkers(runtime, store); const abort = new AbortController();
  try {
    const promise = workers.review({cwd:home,sessionKey:"parent",fingerprint:"bytes",prompt:"review",thinking:"low",signal:abort.signal});
    while (!runtime.sessions.size || ![...runtime.sessions.values()][0].busy) await new Promise(r => setTimeout(r,1));
    abort.abort(); await assert.rejects(promise,/cancelled/);
    assert.equal(disposed,true); assert.equal(store.list()[0].status,"cancelled");
  } finally { await workers.stop(); await rm(home,{recursive:true,force:true}); }
});

test("real dedicated Dispatcher executes tool-free review without parent Harness turns", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-worker-"));
  const runtime = new FakeRuntime(() => '{"findings":[]}');
  const store = new ExecutionStore(path.join(home, "executions.json"));
  const workers = new ReviewWorkers(runtime, store);
  try {
    const result = await workers.review({ cwd: home, sessionKey: "busy-parent", fingerprint: "bytes", prompt: "review snapshot", thinking: "low" });
    assert.equal(result.kind, "dispatcher-worker"); assert.equal(result.fingerprint, "bytes");
    assert.equal(result.result, '{"findings":[]}');
    assert.equal(runtime.opened.length, 1); assert.equal(runtime.opened[0].key.startsWith("dispatch:"), true);
    assert.equal(store.list()[0].status, "completed");
  } finally { await workers.stop(); await rm(home, { recursive: true, force: true }); }
});
