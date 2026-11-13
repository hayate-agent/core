import assert from "node:assert/strict";
import test from "node:test";
import { TurnActivity, type ActivityEvent } from "../src/activity.js";

for (const error of [false, true]) {
  test(`correlated ${error ? "failed" : "completed"} tool retains its start name`, () => {
    const events: ActivityEvent[] = [];
    const activity = new TurnActivity({ id: "synthetic-turn", role: "main", context: "operator" }, e => events.push(e), {}, () => 1000);
    try {
      activity.event({ type: "tool", phase: "start", name: "read", callId: "a" });
      const started = events.at(-1)!.tool!;
      activity.event({ type: "tool", phase: "start", name: "write", callId: "b" });
      activity.event({ type: "tool", phase: "end", name: "bash", callId: "a", error });
      assert.deepEqual(events.at(-1)!.tool, { ...started, state: error ? "failed" : "completed" });
      assert.deepEqual(activity.snapshot().tools.map(t => t.name), ["write"]);
      const count = events.length;
      activity.event({ type: "tool", phase: "end", name: "read", callId: "unknown" });
      assert.equal(events.length, count);
    } finally { activity.finish("completed"); }
  });
}

test("correlated completion retains sanitized start metadata", () => {
  const events: ActivityEvent[] = [];
  const activity = new TurnActivity({ id: "synthetic-turn", role: "worker", context: "worker" }, e => events.push(e), {}, () => 1000);
  try {
    activity.event({ type: "tool", phase: "start", name: "synthetic unsafe name", callId: "a" });
    activity.event({ type: "tool", phase: "end", name: "read", callId: "a" });
    assert.equal(events.at(-1)!.tool!.name, "tool");
    assert.deepEqual(activity.snapshot().tools, []);
  } finally { activity.finish("completed"); }
});
