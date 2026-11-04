import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { PiSession } from "../src/runtime/pi.js";
import { TurnActivity, type ActivityEvent } from "../src/activity.js";
import { NativeActivityDelivery } from "../src/builtin-plugins/native-activity.js";
import { HarnessTuiChannel } from "../src/channels/tui.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const role of ["main", "worker", "dispatcher-classifier"] as const) test(`${role}: selection lifecycle, unavailable partial telemetry and cancellation`, () => {
  let now = 0;
  const events: ActivityEvent[] = [];
  const a = new TurnActivity({ id: role, role, context: "operator" }, e => events.push(e), { intervalMs: 1000 }, () => now);
  a.running(true);
  now = 10000; a.tick();
  assert.ok(events.every(e => e.snapshot.phase === "starting" && e.snapshot.executionState === "pending"));
  a.event({ type: "execution", selection: { model: "p/actual", thinking: "off" } });
  assert.equal(a.snapshot().phase, "running");
  assert.equal(a.snapshot().executionState, "observed");
  a.finish("cancelled");
  assert.equal(a.snapshot().phase, "cancelled");
  assert.equal(new Set(events.map(e => e.snapshot.id)).size, 1);
  const b = new TurnActivity({ id: role, role, context: "operator" }, () => {});
  b.running(true); b.event({ type: "execution", selection: { model: "p/partial" } });
  assert.equal(b.snapshot().executionState, "unavailable"); b.finish("failed");
  const legacy = new TurnActivity({ id: role, role, context: "operator" }, () => {});
  legacy.running(); assert.equal(legacy.snapshot().executionState, "unavailable"); legacy.finish("completed");
});

for (const scenario of ["override", "default", "failure", "disabled"] as const) test(`real Harness + PiSession: ${scenario}, held SDK setup and native/TUI rows`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "selection-lifecycle-"));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const waiting = new Promise<void>(r => { entered = r; });
  const A = { provider: "p", id: "old" }, B = { provider: "p", id: "actual" };
  let prompts = 0;
  let runningLabel = "";
  const sdk = {
    model: A, thinkingLevel: "high", messages: [], systemPrompt: "", 
    async setModel(model: typeof A) { entered(); await gate; if (scenario === "failure") throw Error("setup failed"); this.model = model; this.thinkingLevel = "off"; },
    setThinkingLevel(_level: string) { this.thinkingLevel = "off"; },
    subscribe() { return () => {}; }, async prompt() {
      prompts++;
      await delivery.flush();
      runningLabel = [...(ui as any).classifiers.values()].at(-1)?.label ?? "";
    }, async waitForIdle() {},
    getLastAssistantText() { return "done"; }, getSessionStats() { return { tokens: {}, cost: {} }; }, getContextUsage() { return undefined; },
    async abort() {}, dispose() {},
  };
  const pi = new PiSession(sdk as never, { getModel: () => B, getAvailable: () => [A, B], getApiKey: async () => "fake" } as never, {}, undefined, undefined, undefined,
    scenario === "default" ? async () => { entered(); await gate; } : undefined);
  const runtime = new FakeRuntime(); runtime.open = async () => pi;
  const events: ActivityEvent[] = [], rows: Array<{ id: string; text: string }> = [];
  const delivery = new NativeActivityDelivery(path.join(dir, "outbox.json"), async (_to, id, text) => { rows.push({ id, text }); }, 60000);
  const ui = new HarnessTuiChannel({ color: false });
  const channel = new MemoryChannel();
  Object.assign(channel, { taskActivity(to: any, e: ActivityEvent) { events.push(e); delivery.event(to, e); ui.taskActivity(to, e); } });
  const harness = new Harness({ runtime, tickMs: 60000, activity: { enabled: scenario !== "disabled" } });
  harness.addChannel(channel); harness.onStateChange = async () => {};
  try {
    const input = msg("work");
    if (scenario !== "default") input.turn = { model: "p/actual", thinking: "high" };
    await harness.accept(input); await waiting;
    await delivery.flush();
    assert.equal(prompts, 0);
    assert.ok(events.every(e => e.snapshot.phase === "starting"));
    assert.ok(rows.every(r => /preparing model selection/.test(r.text) && !/running|model p\/old/.test(r.text)));
    if (scenario !== "disabled") assert.match([...(ui as any).classifiers.values()].at(-1).label, /starting.*preparing model selection/);
    release(); await harness.drained(); await delivery.flush();
    if (scenario === "disabled") { assert.equal(events.length, 0); assert.equal(prompts, 1); }
    else if (scenario === "failure") {
      assert.equal(prompts, 0); assert.equal(events.at(-1)?.snapshot.phase, "failed");
      assert.ok(!events.some(e => e.snapshot.phase === "running"));
    } else {
      const running = events.find(e => e.snapshot.phase === "running")!;
      assert.deepEqual(running.snapshot.execution, { model: scenario === "default" ? "p/old" : "p/actual", thinking: scenario === "default" ? "high" : "off" });
      assert.ok(rows.some(row => (scenario === "default" ? /model p\/old · reasoning high.*running/ : /model p\/actual · reasoning off.*running/).test(row.text)));
      assert.match(runningLabel, /running.*reasoning (off|high)/);
      assert.equal(new Set(rows.map(row => row.id)).size, 1);
      assert.equal(sdk.model, A); assert.equal(prompts, 1);
      assert.equal(new Set(events.map(e => e.snapshot.id)).size, 1);
    }
  } finally { release(); await harness.stop(1000); delivery.stop(); await rm(dir, { recursive: true, force: true }); }
});
