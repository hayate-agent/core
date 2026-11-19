import test from "node:test";
import assert from "node:assert/strict";
import { TurnActivity } from "../src/activity.js";
import { GatewayProgress } from "../src/channels/progress.js";

test("known local queue state is content-free waiting, not own inference/tool activity or proof of progress", async () => {
  let now = 0;
  const activity = new TurnActivity({ id: "queue", role: "main", context: "operator" }, () => {}, { maxAlive: 0 }, () => now);
  const sent: string[] = [], gateway = new GatewayProgress("reduced", async text => { sent.push(text); });
  try {
    now = 5000;
    for (const state of ["waiting", "admitted", "cancelled"] as const) {
      activity.event({ type: "model_queue", state }); gateway.event({ type: "model_queue", state });
      assert.equal(activity.snapshot().inactiveMs, 5000, "capacity metadata does not count as own semantic activity");
      assert.deepEqual(activity.snapshot().tools, []);
      await new Promise<void>(resolve => setImmediate(resolve)); // coalesced transports may omit an immediately superseded state
    }
    await gateway.finish();
    assert(sent.some(text => text.includes("Modellkapazität")));
    assert(sent.some(text => text.includes("Anbieterfortschritt noch unbekannt")));
  } finally { activity.finish("cancelled"); await gateway.finish(); }
});
