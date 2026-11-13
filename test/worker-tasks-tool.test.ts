import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginHost } from "../src/plugins.js";
import { workerTasksPlugin } from "../src/worker-tasks-plugin.js";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";

test("model board shares command persistence but inherits dispatcher parent authority", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "worker-tool-"));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  let calls = 0, operatorAdmissions = 0;
  const mandate = { taskId: "original", original: "Read-only test", depth: 0 };
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false,
    execute: async () => { calls++; return "persisted model-board result"; } }, 1, async () => {}, () => {}, () => mandate);
  await dispatcher.start();
  t.after(async () => { await dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  const host = new PluginHost();
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [workerTasksPlugin(home, () => dispatcher,
    async (parent, id, input) => { operatorAdmissions++; return dispatcher.submit(parent, id, input); })]);
  const tool = host.tools.get("plugin_worker_tasks")!;
  const context = { sessionKey: "main" };
  await tool.execute({ action: "profile", name: "probe", instructions: "Read only" }, context);
  await tool.execute({ action: "submit", requestId: "one", profile: "probe", task: "test" }, context);
  for (let i = 0; i < 200 && store.list()[0]?.status !== "completed"; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(operatorAdmissions, 0);
  assert.equal(store.list()[0].dependency?.taskId, "original");
  assert.equal(store.list()[0].status, "completed");
  assert.match(String(await host.commands.get("worker-tasks")!.run("status", context)), /persisted model-board result/);
  await tool.execute({ action: "profile", name: "probe", instructions: "Changed" }, context);
  await tool.execute({ action: "submit", requestId: "one", profile: "probe", task: "test" }, context);
  assert.equal(calls, 1);
  await assert.rejects(tool.execute({ action: "submit", requestId: "one", profile: "probe", task: "different" }, context), /Conflicting/);
  assert.deepEqual(JSON.parse(await tool.execute({ action: "status" }, { sessionKey: "other" })).tasks, []);
  await assert.rejects(tool.execute({ action: "status" }, { sessionKey: "dispatch:child" }), /Nested/);
  await assert.rejects(tool.execute({ action: "status" }, { sessionKey: "subagent:child" }), /Nested/);
  await assert.rejects(tool.execute({ action: "status" }, { ...context, signal: AbortSignal.abort() }), /aborted/);
  await assert.rejects(tool.execute({ action: "submit", requestId: "bad id", profile: "probe", task: "test" }, context), /Invalid/);
});

test("model tool keeps instruction and task whitespace byte-exact; slash command parsing unchanged", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "worker-tool-ws-"));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const seen: string[] = [];
  const mandate = { taskId: "original", original: "Read-only test", depth: 0 };
  const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false,
    execute: async (execution: { input: string }) => { seen.push(execution.input); return "ok"; } } as any, 1, async () => {}, () => {}, () => mandate);
  await dispatcher.start();
  t.after(async () => { await dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  const host = new PluginHost();
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [workerTasksPlugin(home, () => dispatcher, async (p, id, i) => dispatcher.submit(p, id, i))]);
  const tool = host.tools.get("plugin_worker_tasks")!;
  const context = { sessionKey: "main" };
  const instructions = "Rule 1\n  Rule 2\n\nRule 3";
  await tool.execute({ action: "profile", name: "p", instructions }, context);
  const tasks = ["line1\nline2", "  indented\n    code  block\n\n- item", "a  b", "tab\there", "x\n"];
  for (const [i, task] of tasks.entries()) {
    await tool.execute({ action: "submit", requestId: `r${i}`, profile: "p", task }, context);
    for (let k = 0; k < 200 && seen.length <= i; k++) await new Promise(r => setTimeout(r, 5));
    assert.equal(seen[i], `Worker profile: p\nInstructions: ${instructions}\n\nTask: ${task}`);
  }
  // Identical structured retry stays idempotent.
  await tool.execute({ action: "submit", requestId: "r0", profile: "p", task: tasks[0] }, context);
  assert.equal(seen.length, tasks.length);
  const commandRun = host.commands.get("worker-tasks")!.run;
  assert.match(String(await commandRun("profile q  slash   words\nhere", context)), /saved/);
  assert.equal(JSON.parse(String(await commandRun("status", context))).profiles.q, "slash words here");
  await assert.rejects(Promise.resolve().then(() => commandRun("profile q", context)), /Use \/worker-tasks/);
  await assert.rejects(Promise.resolve().then(() => commandRun("submit only p", context)), /Use \/worker-tasks/);
});
