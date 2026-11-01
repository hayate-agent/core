import test from "node:test";
import assert from "node:assert/strict";
import { Harness, type DurableTask } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
const key = "mem:room1";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const retained = (): DurableTask => ({ id: "original", original: "Verify already published result; do not publish again", state: "active", depth: 2, lastReply: "Published receipt 123" });

for (const mode of ["inconclusive", "unavailable"] as const)
for (const stored of [false, true]) test(`${mode}, stored next=${stored}: restart reconciles once without replaying completed effects`, async () => {
  const task = retained(); if (stored) task.next = "Read receipt 123, no publication";
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000,
    ...(mode === "inconclusive" ? { completionCheck: async (_i: unknown, _r: unknown, _s: unknown, diagnostic?: (v: "inconclusive") => void) => { diagnostic?.("inconclusive"); return undefined; } } : {}) });
  h.restoreSessions([{ key, task }]); h.onStateChange = async () => {};
  let snapshot: ReturnType<Harness["snapshotSessions"]>;
  try { await h.recoverTasks(); snapshot = clone(h.snapshotSessions()); }
  finally { await h.stop(0); }
  let turns = 0;
  const runtime = new FakeRuntime(prompt => {
    turns++; assert.match(prompt, stored ? /Read receipt 123/ : /Published receipt 123/);
    assert.match(prompt, /do not repeat|never replay|Verify completed side effects/);
    restored.planContinuation(key, { state: "completed" }); return "Receipt 123 verified; no necessary next move.";
  });
  const restored = new Harness({ runtime, tickMs: 60000 }); restored.addChannel(new MemoryChannel());
  restored.restoreSessions(snapshot!); restored.onStateChange = async () => {};
  try {
    await restored.recoverTasks(); restored.releaseRestored(); await restored.drained();
    await restored.tick(); await restored.drained();
    assert.equal(turns, 1); assert.equal(restored.state(key).task!.id, "original");
    assert.equal(restored.state(key).task!.state, "completed");
    const again = new Harness({ runtime, tickMs: 60000 }); again.restoreSessions(clone(restored.snapshotSessions())); again.onStateChange = async () => {};
    try { await again.recoverTasks(); again.releaseRestored(); await again.tick(); await again.drained(); assert.equal(turns, 1); }
    finally { await again.stop(0); }
  } finally { await restored.stop(0); }
});

for (const boundary of ["completed", "stopped", "paused", "expired", "budget"] as const)
test(`unavailable assessor respects ${boundary}`, async () => {
  const task = retained();
  if (boundary === "completed" || boundary === "stopped") task.state = boundary;
  if (boundary === "expired") task.expiresAt = 99;
  if (boundary === "budget") task.depth = 20;
  let turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "must not run"; }), tickMs: 60000, now: () => 100 });
  h.restoreSessions([{ key, task }]); h.onStateChange = async () => {}; if (boundary === "paused") h.paused = true;
  try { await h.recoverTasks(); h.releaseRestored(); await h.tick(); await h.drained(); assert.equal(turns, 0); }
  finally { await h.stop(0); }
});

test("genuine completed Q&A stays completed without assessor or replay", async () => {
  const task = retained(); task.original = "What is 2+2?"; task.lastReply = "4"; task.state = "completed";
  const h = new Harness({ runtime: new FakeRuntime(() => { throw Error("completed Q&A must not run"); }), tickMs: 60000 });
  h.restoreSessions([{ key, task }]); h.onStateChange = async () => {};
  try { await h.recoverTasks(); await h.tick(); await h.drained(); assert.equal(h.state(key).task!.lastReply, "4"); }
  finally { await h.stop(0); }
});

test("repeated inconclusive working attempts use existing bounded progress guard, not evaluator-only loops", async () => {
  let checks = 0, turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "No new evidence"; }), tickMs: 60000,
    completionCheck: async (_i, _r, _s, diagnostic) => { checks++; diagnostic?.("inconclusive"); return undefined; } });
  h.restoreSessions([{ key, task: retained() }]); h.onStateChange = async () => {};
  try {
    await h.recoverTasks(); h.releaseRestored(); await h.drained();
    for (let i = 0; i < 25; i++) { await h.tick(); await h.drained(); }
    assert.equal(h.state(key).task!.state, "blocked");
    assert.ok(turns > 0 && turns <= 20); assert.ok(checks <= turns + 1);
    const before = turns; await h.tick(); await h.drained(); assert.equal(turns, before);
  } finally { await h.stop(0); }
});
