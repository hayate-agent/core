import assert from "node:assert/strict";
import { test } from "node:test";
import { TurnActivity, type ActivityEvent } from "../src/activity.js";
import { toTurnEvent } from "../src/runtime/pi.js";

test("own reasoning and tool-argument deltas show bounded activity without exporting private content", () => {
  let now = 0; const events: ActivityEvent[] = [];
  const activity = new TurnActivity({ id: "fixture", role: "main", context: "operator" }, e => events.push(e), { intervalMs: 1000 }, () => now);
  try {
    for (const [type, expected] of [["thinking_delta", "model reasoning active"], ["toolcall_delta", "preparing tool arguments"]] as const) {
      const event = toTurnEvent({ type: "message_update", assistantMessageEvent: { type, delta: "PRIVATE REASONING/ARGUMENTS" } } as any)!;
      assert.equal(event.type, "model_progress");
      now += 1500; activity.event(event); assert.equal(activity.snapshot().activity, expected);
      const before = events.length;
      for (let i = 0; i < 100; i++) activity.event(event);
      assert.equal(events.length, before, "token rate does not create unbounded status updates");
      now += 500; activity.event(event); now += 500; activity.tick();
      assert.equal(activity.snapshot().inactiveMs, 500);
    }
    assert(!JSON.stringify(events).includes("PRIVATE"));
    assert.equal(toTurnEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "" } } as any), undefined);
  } finally { activity.finish("completed"); }
});
