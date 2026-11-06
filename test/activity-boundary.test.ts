// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { ActivityEvent } from "../src/activity.js";

test("native terminal waits for actual completion hook, not runtime return", async () => {
  let release!: () => void;
  let entered = false;
  const events: ActivityEvent[] = [];
  const channel = new MemoryChannel();
  Object.assign(channel, { taskActivity: (_to: unknown, event: ActivityEvent) => events.push(event) });
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000,
    turnCommitted: async () => { entered = true; await new Promise<void>(resolve => { release = resolve; }); },
  });
  harness.addChannel(channel); harness.onStateChange = async () => {};
  await harness.accept(msg("private", "operator", "main"));
  while (!entered) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(!events.some(e => ["completed", "failed", "cancelled"].includes(e.snapshot.phase)));
  release(); await harness.waitForSessionIdle("main");
  assert.equal(events.at(-1)?.snapshot.phase, "completed");
});
