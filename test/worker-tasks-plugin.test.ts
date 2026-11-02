import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";
import { PluginHost } from "../src/plugins.js";
import { workerTasksPlugin } from "../src/worker-tasks-plugin.js";
import { builtinCommandNames } from "../src/commands.js";

test("worker board activates with the real built-in command reservations", async () => {
  const registry = new PluginHost();
  await registry.load([], { home: ".", agent: "test", cwd: "." }, builtinCommandNames, [],
    [workerTasksPlugin(".", () => undefined, async () => { throw Error("not invoked"); })]);
  assert.ok(builtinCommandNames.includes("agents"));
  assert.ok(registry.commands.has("tasks"));
});

test("worker board executes through durable dispatcher, survives reload and archive, deduplicates profile snapshots", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "worker-board-"));
  let executions = 0;
  const ledger = path.join(home, "ledger.json");
  const create = async () => {
    const store = new ExecutionStore(ledger);
    await store.load();
    const dispatcher = new Dispatcher(store, { name: "direct", version: 1, replaySafe: false,
      execute: async task => { executions++; assert.match(task.input, /Instructions: original/); return "visible durable result"; } },
      1, async () => {}, error => { throw error; });
    await dispatcher.start();
    const registry = new PluginHost();
    await registry.load([], { home, agent: "test", cwd: home }, [], [], [workerTasksPlugin(home, () => dispatcher, (parent, id, input) => dispatcher.submit(parent, id, input))]);
    const run = (args: string, sessionKey = "operator") => registry.commands.get("tasks")!.run(args, { sessionKey });
    return { dispatcher, store, run };
  };
  let runtime = await create();
  t.after(async () => { await runtime.dispatcher.stop(); await rm(home, { recursive: true, force: true }); });
  await runtime.run("profile developer original");
  await runtime.run("submit first developer perform task");
  for (let i = 0; i < 200 && runtime.store.list()[0]?.status !== "completed"; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(runtime.store.list()[0]?.status, "completed");
  assert.match(String(await runtime.run("status")), /visible durable result/);
  await runtime.run("profile developer changed");
  await runtime.run("submit first developer perform task");
  await assert.rejects(runtime.run("submit first developer different task"), /Conflicting/);
  await assert.rejects(runtime.run("submit nested developer task", "dispatch:worker"), /Nested/);
  assert.deepEqual(JSON.parse(String(await runtime.run("status", "other"))).tasks, []);
  await runtime.store.compact("operator", 0);
  assert.equal(runtime.store.list().length, 0);
  assert.match(String(await runtime.run("status")), /visible durable result/);
  await runtime.dispatcher.stop();
  runtime = await create();
  await runtime.run("submit first developer perform task");
  assert.match(String(await runtime.run("status")), /visible durable result/);
  assert.equal(executions, 1);
});
