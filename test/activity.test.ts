// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnActivity, type ActivityEvent } from "../src/activity.js";

test("host liveness is measured, coalesced, bounded and stops terminally", () => {
  let now = 0;
  const events: ActivityEvent[] = [];
  const activity = new TurnActivity({ id: "stable", role: "main", context: "operator" }, e => events.push(e), { intervalMs: 1000, maxAlive: 2 }, () => now);
  activity.running();
  now = 900; activity.event({ type: "text", delta: "private output" });
  now = 1000; activity.tick(); assert.equal(events.length, 2);
  now = 1900; activity.tick(); assert.equal(events.at(-1)?.kind, "alive");
  assert.equal(events.at(-1)?.snapshot.inactiveMs, 1000);
  now = 2900; activity.tick(); now = 3900; activity.tick();
  assert.equal(events.filter(e => e.kind === "alive").length, 2);
  activity.finish("cancelled"); now = 9000; activity.tick();
  assert.equal(events.at(-1)?.snapshot.phase, "cancelled");
  assert.equal(events.at(-1)?.snapshot.elapsedMs, 3900);
  assert.ok(!JSON.stringify(events).includes("private output"));
});

test("concurrent identical tools retain distinct correlation and never expose detail", () => {
  const events: ActivityEvent[] = [];
  const activity = new TurnActivity({ id: "stable", role: "worker", parent: "secret context", context: "worker" }, e => events.push(e));
  for (const callId of ["a", "b"]) activity.event({ type: "tool", phase: "start", name: "bash", callId, detail: "TOKEN=secret" });
  assert.equal(activity.snapshot().tools.length, 2);
  activity.event({ type: "tool", phase: "end", name: "bash", callId: "a", error: true });
  assert.equal(activity.snapshot().tools.length, 1);
  activity.event({ type: "tool", phase: "start", name: "TOKEN=secret", callId: "c" });
  assert.ok(!JSON.stringify(events).includes("secret"));
  activity.finish("failed");
  assert.equal(activity.snapshot().tools.length, 0);
});

test("stable identity survives reconstruction; observation does not schedule work", () => {
  const events: ActivityEvent[] = [];
  const make = () => new TurnActivity({ id: "durable-turn", role: "main", context: "operator" }, e => events.push(e), { maxAlive: 0 });
  const first = make(); const id = first.snapshot().id; first.finish("completed");
  const second = make(); assert.equal(second.snapshot().id, id); second.finish("completed");
  assert.ok(events.every(e => e.type === "activity" && !Object.hasOwn(e, "prompt")));
});
