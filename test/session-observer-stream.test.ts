import test from "node:test";
import assert from "node:assert/strict";
import { observeSessionChanges } from "../src/session-observer.js";
import type { SessionObservation } from "../src/harness.js";

const snapshot = (queued: number): SessionObservation => ({ running: true, prompting: true, queued, paused: false,
  tasks: { active: 1, waiting: 0, blocked: 0, completed: 0, stopped: 0 } });

test("slow observers coalesce updates without a producer queue; detach stops polling", async () => {
  let calls = 0, queued = 0;
  const controller = new AbortController();
  const stream = observeSessionChanges({ observeSession: () => { calls++; return snapshot(queued); } }, "allowed", controller.signal, 10);
  assert.equal((await stream.next()).value?.queued, 0);
  queued = 1; queued = 2; queued = 100;
  await new Promise(r => setTimeout(r, 25));
  assert.equal(calls, 1, "no reader means no background producer or unbounded backlog");
  assert.equal((await stream.next()).value?.queued, 100);
  controller.abort();
  assert.equal((await stream.next()).done, true);
  assert.equal(calls, 2);
});

test("disconnect aborts a pending unchanged-state read promptly", async () => {
  const controller = new AbortController();
  const stream = observeSessionChanges({ observeSession: () => snapshot(0) }, "allowed", controller.signal, 60000);
  await stream.next();
  const pending = stream.next();
  controller.abort();
  assert.equal((await pending).done, true);
});

test("invalid interval and already aborted subscription never invoke the owner", async () => {
  let calls = 0;
  const owner = { observeSession: () => { calls++; return undefined; } };
  const controller = new AbortController();
  await assert.rejects(observeSessionChanges(owner, "allowed", controller.signal, 0).next(), /interval/);
  controller.abort();
  assert.equal((await observeSessionChanges(owner, "allowed", controller.signal).next()).done, true);
  assert.equal(calls, 0);
});
