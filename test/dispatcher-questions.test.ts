// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExecutionStore } from "../src/execution.js";
import { Dispatcher } from "../src/dispatcher.js";

test("strategy questions persist, release capacity and resume only with correlated parent answer", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-question-"));
  const file = path.join(home, "ledger.json");
  let dispatcher: Dispatcher | undefined;
  t.after(async () => { await dispatcher?.stop(); await rm(home, { recursive: true, force: true }); });
  const store = new ExecutionStore(file); await store.load();
  let asked!: () => void; const question = new Promise<void>(resolve => { asked = resolve; });
  let finished!: () => void; const result = new Promise<void>(resolve => { finished = resolve; });
  const errors: unknown[] = []; let calls = 0;
  const strategy = { name: "questions", version: 1, replaySafe: false, execute: async (task: ReturnType<ExecutionStore["list"]>[number], context: import("../src/dispatcher.js").DispatchContext) => {
    calls++;
    if (!task.question?.answer) { await context.checkpoint("prepared"); await context.question!("Which environment?"); }
    assert.equal(task.checkpoint, "prepared");
    await context.status!("Answer received");
    return `Environment: ${task.question!.answer}`;
  } };
  dispatcher = new Dispatcher(store, strategy, 1, async event => {
    if (event.type === "question") asked();
    if (event.type === "result") { assert.equal(event.text, "Environment: staging"); finished(); }
  }, error => errors.push(error));
  await dispatcher.start(); const task = await dispatcher.submit("parent", "request", "work"); await question;
  await dispatcher.stop();
  const reopened = new ExecutionStore(file); await reopened.load();
  const pending = reopened.list()[0]!;
  assert.equal(pending.status, "paused"); assert.equal(pending.token, undefined);
  await assert.rejects(reopened.control(task.id, "resume"), /cannot resume/);
  await assert.rejects(reopened.answer("other", task.id, pending.question!.id, "staging"), /no longer/);
  dispatcher = new Dispatcher(reopened, strategy, 1, async event => { if (event.type === "result") { assert.equal(event.text, "Environment: staging"); finished(); } }, error => errors.push(error));
  await dispatcher.start(); await dispatcher.answer("parent", task.id, pending.question!.id, "staging"); await result;
  assert.equal(calls, 2);
  await assert.rejects(reopened.answer("parent", task.id, pending.question!.id, "again"), /no longer/);
  assert.deepEqual(errors, []);
});
