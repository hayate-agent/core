import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnActivity, type ActivityEvent } from "../src/activity.js";
import { defaultConfig } from "../src/config.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

test("disabled activity emits nothing; configuration rejects invalid shapes and bounds", () => {
  let events = 0;
  const activity = new TurnActivity({ id: "x", role: "main", context: "operator" }, () => { events++; }, { enabled: false });
  activity.running(); activity.tick(); activity.finish("completed");
  assert.equal(events, 0);
  for (const value of [null, [], "yes", { enabled: "yes" }, { intervalMs: 0 }, { maxAlive: 121 }, { maxAlive: 1.5 }]) {
    assert.throws(() => defaultConfig({ activity: value as never }), /Invalid activity policy/);
  }
  assert.equal(defaultConfig({ activity: { enabled: false, maxAlive: 0 } }).activity?.enabled, false);
});

test("throwing activity sink cannot fail work or its final commit", async () => {
  const runtime = new FakeRuntime(); const channel = new MemoryChannel();
  Object.assign(channel, { taskActivity: () => { throw Error("telemetry offline"); } });
  const harness = new Harness({ runtime, tickMs: 60000 });
  harness.addChannel(channel); harness.onStateChange = async () => {};
  try {
    await harness.submit(msg("work")); await harness.drained();
    assert.equal(runtime.sessions.get("mem:room1")?.prompts.length, 1);
    assert.equal(channel.sent.length, 1);
  } finally { await harness.stop(1000); }
});

test("failed commit closes activity; shutdown closes an uncooperative running turn", async () => {
  for (const failure of ["commit", "shutdown"] as const) {
    const runtime = new FakeRuntime(); const channel = new MemoryChannel(); const events: ActivityEvent[] = [];
    Object.assign(channel, { taskActivity: (_to: unknown, event: ActivityEvent) => events.push(event) });
    let entered = false, release: (() => void) | undefined;
    if (failure === "shutdown") runtime.answer = () => "done";
    const harness = new Harness({ runtime, tickMs: 60000,
      afterTurn: failure === "shutdown" ? async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); return "done"; } : undefined,
      turnCommitted: failure === "commit" ? async () => { throw Error("commit unavailable"); } : undefined,
    });
    harness.addChannel(channel); harness.onStateChange = async () => {};
    await harness.accept(msg("work"));
    if (failure === "commit") {
      await harness.drained();
      assert.equal(events.at(-1)?.snapshot.phase, "failed");
      await harness.stop(1000);
    } else {
      while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
      await harness.stop(0);
      assert.equal(events.at(-1)?.snapshot.phase, "cancelled");
      const count = events.length;
      release!(); await harness.waitForSessionIdle("mem:room1");
      assert.equal(events.length, count);
    }
  }
});
