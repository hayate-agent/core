import assert from "node:assert/strict";
import { test } from "node:test";
import { toTurnEvent } from "../src/runtime/pi.js";
import { TurnActivity, type ActivityEvent } from "../src/activity.js";
import { GatewayProgress } from "../src/channels/progress.js";

test("automatic SDK compaction has explicit lifecycle metadata without summary/error content", async () => {
  const events: ActivityEvent[] = [];
  const activity = new TurnActivity({ id: "compaction-fixture", role: "main", context: "operator" }, e => events.push(e));
  const sent: string[] = []; const progress = new GatewayProgress("reduced", async text => { sent.push(text); });
  try {
    for (const event of [
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "threshold", result: { summary: "PRIVATE SUMMARY" }, aborted: false },
      { type: "compaction_start", reason: "overflow" },
      { type: "compaction_end", reason: "overflow", result: undefined, aborted: false, errorMessage: "PRIVATE ERROR" },
      { type: "compaction_end", reason: "manual", result: undefined, aborted: true },
    ]) {
      const mapped = toTurnEvent(event as any)!; assert.equal(mapped.type, "compaction");
      activity.event(mapped); progress.event(mapped);
    }
    assert(events.some(e => e.snapshot.activity === "compacting context"));
    assert(events.some(e => e.snapshot.activity === "compaction completed"));
    assert(events.some(e => e.snapshot.activity === "compaction failed; original retained"));
    assert.equal(activity.snapshot().activity, "compaction cancelled; original retained");
    await progress.finish();
    assert(sent.some(s => s.includes("Kontext wird komprimiert")));
    assert(sent.some(s => s.includes("Originalkontext bleibt erhalten")));
    assert(!JSON.stringify({ events, sent }).includes("PRIVATE"));
    assert.equal(activity.snapshot().tools.length, 0, "maintenance is not a productive tool effect");
  } finally { activity.finish("completed"); await progress.finish(); }
});
