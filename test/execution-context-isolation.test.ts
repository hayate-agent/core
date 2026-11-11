import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Dispatcher } from "../src/dispatcher.js";
import { Harness } from "../src/harness.js";
import { dispatcherPlugin } from "../src/builtin-plugins/dispatcher-plugin.js";
import { FakeRuntime } from "./fakes.js";

async function fixture(t: any) {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-isolation-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file); await store.load();
  return { store, file };
}

test("model taskId is an assertion, not a selector; admission exposes exact host mandate", async t => {
  const { store } = await fixture(t);
  const expiresAt = Date.now() + 3600000;
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async () => "done" }, 1, async () => {}, () => {}, () => ({ taskId: "old", original: "old mandate", depth: 0, expiresAt }));
  await dispatcher.start(); t.after(() => dispatcher.stop());
  let tool: any;
  dispatcherPlugin(() => dispatcher).activate({ registerTool: (value: any) => tool = value, registerCommand: () => {} } as any);
  const submit = (taskId?: string) => tool.execute({ action: "submit", requestId: "review", task: "Review newer interface fix", taskId }, { sessionKey: "main" });
  await assert.rejects(submit("new"), /execution-context-mismatch/);
  assert.equal(store.list().length, 0, "no persisted job on mismatch");
  const automatic = JSON.parse(await submit());
  assert.deepEqual(automatic.mandate, { taskId: "old", expiresAt });
  const receipt = JSON.parse(await submit("old"));
  assert.deepEqual(receipt.mandate, { taskId: "old", expiresAt });
  assert.equal(store.list()[0].dependency?.original, "old mandate");
});

test("requestId cannot alias an identical description under another mandate, including after restart", async t => {
  const { store, file } = await fixture(t);
  await store.submit("main", "review", "same description", "direct", 1, { taskId: "old", original: "old", depth: 0 });
  const reopened = new ExecutionStore(file); await reopened.load();
  await assert.rejects(reopened.submit("main", "review", "same description", "direct", 1, { taskId: "new", original: "new", depth: 0 }), /execution-context-mismatch/);
  assert.equal(reopened.list().length, 1);
});

test("queued deadline expiry launches no strategy; diagnostic persists and resume rejects before scheduling", async t => {
  const { store, file } = await fixture(t);
  const task = await store.submit("main", "expired", "review", "direct", 1, { taskId: "old", original: "old", depth: 0, expiresAt: Date.now() - 1 });
  let launches = 0;
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async () => { launches++; return "unexpected"; } }, 1, async () => {}, () => {});
  await dispatcher.start(); await dispatcher.waitForExecution(task.id);
  await dispatcher.stop();
  assert.equal(launches, 0);
  assert.equal(store.list()[0].diagnosticCode, "deadline-expired");
  const reopened = new ExecutionStore(file); await reopened.load();
  await assert.rejects(reopened.control(task.id, "resume"), /deadline-expired/);
  assert.equal(reopened.list()[0].status, "paused");
  let tool: any;
  dispatcherPlugin(() => ({ store: reopened }) as any).activate({ registerTool: (value: any) => tool = value, registerCommand: () => {} } as any);
  const status = JSON.parse(await tool.execute({ action: "status", id: task.id }, { sessionKey: "main" }));
  assert.match(status.tasks[0].diagnostic, /deadline-expired/);
});

test("missing historical or legacy result ancestry never adopts current task", async t => {
  const { store } = await fixture(t);
  const harness = new Harness({ runtime: new FakeRuntime(), executionStore: store, hostEventAllowed: () => true });
  t.after(() => harness.stop(0)); harness.onStateChange = async () => {};
  await harness.accept({ id: "new", sessionKey: "main", source: "channel", text: "New task" });
  await harness.waitForSessionIdle("main");
  const current = harness.sessions.get("main")!.task!;
  for (const dependency of [undefined, { taskId: "missing-old", original: "old", depth: 0 }]) {
    const job = await store.submit("main", `result-${dependency?.taskId}`, "result", "direct", 1, dependency);
    const claim = await store.claim(job.id); await store.complete(job.id, claim.token!, "done");
    assert.equal(harness.resultMandate({ sessionKey: "main", source: "host", text: "new task?", hostEvent: { executionId: job.id } }), undefined);
  }
  assert.equal(harness.sessions.get("main")!.task!.id, current.id);
});

test("delegation snapshots tightest stored deadline even if current input omits it", async t => {
  const harness = new Harness({ runtime: new FakeRuntime() });
  t.after(() => harness.stop(0)); harness.onStateChange = async () => {};
  await harness.accept({ id: "op", sessionKey: "main", source: "channel", text: "Old task" });
  await harness.waitForSessionIdle("main");
  const s = harness.sessions.get("main")!, task = s.task!;
  task.expiresAt = Date.now() + 3600000;
  s.current = { sessionKey: "main", source: "channel", text: "review", taskId: task.id };
  assert.equal(harness.dependencyCheckpoint("main")?.expiresAt, task.expiresAt);
  s.current.continuationExpiresAt = task.expiresAt - 1000;
  assert.equal(harness.dependencyCheckpoint("main")?.expiresAt, task.expiresAt - 1000);
});
