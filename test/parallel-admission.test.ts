import test from "node:test";
import assert from "node:assert/strict";
import { ParallelAdmission, auxiliaryAdmission, bindParallelAdmission } from "../src/parallel-admission.js";
import { dispatcherConfig } from "../src/dispatcher-config.js";

test("queued cancellation removes waiter and preserves capacity", async () => {
  const budget = new ParallelAdmission(1);
  let release!: () => void;
  const held = budget.run(() => new Promise<void>(resolve => { release = resolve; }));
  while (!release) await Promise.resolve();
  const controller = new AbortController();
  let executed = false;
  const waiting = budget.run(async () => { executed = true; }, controller.signal);
  const rejection = assert.rejects(waiting, /cancelled/);
  controller.abort(Error("cancelled"));
  await rejection;
  assert.equal(executed, false);
  release(); await held;
  assert.equal(await budget.run(async () => 42), 42);
});

test("HTTP validators and isolated worktrees use the same admission", async () => {
  const budget = new ParallelAdmission(1);
  const events: string[] = [];
  const child = { async reviewCodeHttp() { events.push("http-review"); return "ok"; } };
  const runtime = { forReviewWorktree() { return child; }, async classifyComplexityHttp() { events.push("classifier"); return "simple"; } };
  bindParallelAdmission(runtime as any, budget);
  const isolated = runtime.forReviewWorktree();
  let release!: () => void;
  const held = budget.run(() => new Promise<void>(resolve => { release = resolve; }));
  while (!release) await Promise.resolve();
  const signal = new AbortController().signal;
  const review = (isolated as any).reviewCodeHttp("", {}, "id", signal);
  const classify = (runtime as any).classifyComplexityHttp({ signal });
  await Promise.resolve();
  assert.deepEqual(events, []);
  release(); await Promise.all([held, review, classify]);
  assert.deepEqual(events, ["http-review", "classifier"]);
});

test("auxiliary accounting defaults false and validates boolean", () => {
  assert.equal(dispatcherConfig().countAuxiliaryRuns, false);
  assert.throws(() => dispatcherConfig({ countAuxiliaryRuns: "true" } as any));
});
test("enabled model work shares capacity and nested validator does not deadlock", async () => {
  const budget = new ParallelAdmission(1), runtime = {};
  bindParallelAdmission(runtime as any, budget);
  let release!: () => void;
  const events: string[] = [];
  const first = budget.run(async () => {
    events.push("task");
    await auxiliaryAdmission(runtime, async () => { events.push("nested-validator"); });
    await new Promise<void>(resolve => { release = resolve; });
  });
  while (!release) await Promise.resolve();
  const second = auxiliaryAdmission(runtime, async () => { events.push("memory"); });
  await Promise.resolve();
  assert.deepEqual(events, ["task", "nested-validator"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(events, ["task", "nested-validator", "memory"]);
});
test("disabled auxiliary admission runs independently; exceptions release slot", async () => {
  assert.equal(await auxiliaryAdmission({}, async () => 42), 42);
  const budget = new ParallelAdmission(1);
  await assert.rejects(budget.run(async () => { throw Error("failed"); }));
  assert.equal(await budget.run(async () => 7), 7);
});
