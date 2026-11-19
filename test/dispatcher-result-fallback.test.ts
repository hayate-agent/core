import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { ExecutionStore } from "../src/execution.js";
import type { Harness } from "../src/harness.js";

for (const optimization of ["missing", "passthrough", "throws"] as const) {
  test(`dispatcher durable fallback retains tail uncertainty and exact session reference: ${optimization}`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-report-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const file = path.join(home, "executions.json");
    const store = new ExecutionStore(file); await store.load();
    const task = await store.submit("parent", "request", "Inspect once; reconcile uncertain outcome", "direct");
    const running = await store.claim(task.id);
    const report = "Observed receipt 123; not proof of task completion.\n" + "ordinary evidence\n".repeat(5000) +
      "\nINCOMPLETE: remote effect uncertain; inspect actual state. Never repeat receipt 123.";
    let workers = 0, optimizations = 0, settlements = 0;
    let bridge!: DispatcherRuntime;
    const harness = {
      runtime: optimization === "missing" ? {} : { compactResult: async (key: string, text: string) => {
        optimizations++;
        assert.equal(key, `dispatch:${task.id}:${running.token}`);
        assert.equal(text, report, "optional shortening sees the original report");
        if (optimization === "throws") throw Error("optional artifact store unavailable");
        return text;
      } },
      accept: async (input: { replyTo: { target: string } }) => {
        workers++;
        await bridge.channel.send({ channel: "dispatch", target: input.replyTo.target }, report);
      },
    } as unknown as Harness;
    bridge = new DispatcherRuntime(harness, store);
    const context = {
      signal: new AbortController().signal,
      intent: (key: string, replay: "unsafe" | "safe") => store.intent(task.id, running.token!, key, replay),
      checkpoint: (value: string) => store.checkpoint(task.id, running.token!, value),
      settleIntent: async (key: string, result: string, checkpoint?: string) => {
        settlements++;
        assert.equal(result, checkpoint, "durable checkpoint carries the same honest excerpt");
        await store.settleIntent(task.id, running.token!, key, result, checkpoint);
      },
    };
    const result = await bridge.strategy.execute(running, context);
    assert(result.length < 64000);
    assert.match(result, /^Observed receipt 123/);
    assert.match(result, /Report excerpted for durable state/);
    assert(result.includes(`full native session dispatch:${task.id}:${running.token} retained`));
    assert.match(result, /Omitted material is not proof of success/);
    assert.match(result, /INCOMPLETE: remote effect uncertain; inspect actual state\. Never repeat receipt 123\.$/);
    assert.equal(workers, 1); assert.equal(settlements, 1);
    assert.equal(optimizations, optimization === "missing" ? 0 : 1);
    // A restart after effect settlement must reuse the exact bounded report,
    // not run the completed operation or optional optimizer again.
    const restored = new ExecutionStore(file); await restored.load();
    const replay = new DispatcherRuntime(harness, restored);
    assert.equal(await replay.strategy.execute(restored.list()[0]!, context), result);
    assert.equal(workers, 1); assert.equal(settlements, 1);
    assert.equal(optimizations, optimization === "missing" ? 0 : 1);
  });
}

test("dispatcher leaves a report at the existing 64K boundary exact", async () => {
  const report = "x".repeat(64000); let bridge!: DispatcherRuntime;
  const harness = { runtime: {}, accept: async (input: { replyTo: { target: string } }) => {
    await bridge.channel.send({ channel: "dispatch", target: input.replyTo.target }, report);
  } } as unknown as Harness;
  bridge = new DispatcherRuntime(harness, {} as ExecutionStore);
  assert.equal(await bridge.strategy.execute({ id: "task", token: "claim", input: "work" } as never, {
    signal: new AbortController().signal, intent: async () => {}, checkpoint: async () => {}, settleIntent: async () => {},
  }), report);
});
