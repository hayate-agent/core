import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ExecutionStore } from "../src/execution.js";

test("retained assessment question survives restart and answer never settles the effect intent", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "assessment-question-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file);
  await store.load();
  const task = await store.submit("parent", "request", "authorized work", "sequential");
  const running = await store.claim(task.id);
  await store.intent(task.id, running.token!, "worker-effect", "unsafe");
  await assert.rejects(store.ask(task.id, running.token!, "Clarify?"), /unresolved effect intent/);
  await assert.rejects(store.ask(task.id, running.token!, "Clarify?", true), /checkpoint required/);
  await store.checkpoint(task.id, running.token!, JSON.stringify({
    outcomes: [], assessment: { mainClarification: true, index: 0, reply: "Retained report" },
  }));
  await store.ask(task.id, running.token!, "Which evidence is missing?", true);
  const question = store.list()[0]!.question!;
  const fresh = new ExecutionStore(file);
  await fresh.load();
  assert.equal(fresh.list()[0]!.question?.retainedAssessment, true);
  await assert.rejects(fresh.answer("other-parent", task.id, question.id, "Override"), /awaiting/);
  await assert.rejects(fresh.answer("parent", task.id, "stale-id", "Override"), /awaiting/);
  await fresh.answer("parent", task.id, question.id, "Inspect existing evidence only");
  assert.equal(fresh.list()[0]!.intent?.key, "worker-effect");
  assert.equal(fresh.list()[0]!.intent?.replay, "unsafe");
  assert.equal(fresh.list()[0]!.settledEffect, undefined);
  await assert.rejects(fresh.answer("parent", task.id, question.id, "Again"), /awaiting/);
});
