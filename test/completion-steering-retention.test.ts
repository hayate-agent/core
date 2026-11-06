// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
const mandate = "Implement the approved test-selection policy and its regression tests";
const next = "Reconcile existing test configuration before implementing the authorized policy; do not repeat completed effects";

async function steerMandate(h: Harness, runtime: FakeRuntime, text = mandate) {
  await h.submit(msg("Explain the current test failures"));
  await h.drained();
  const session = runtime.sessions.get(key)!;
  const release = session.hold();
  await h.submit(msg("Explain one more diagnostic detail"));
  while (!h.state(key).prompting) await new Promise(resolve => setTimeout(resolve, 1));
  await h.submit(msg(text));
  release();
  await h.drained();
}

test("steered implementation survives informational turn and status answer; only retained authority resumes", async () => {
  let h: Harness;
  const runtime = new FakeRuntime(text => text.includes("Original task:") ? "Reconciled" : "Not implemented; only saved");
  let observed = false;
  h = new Harness({ runtime, busyMode: "steer", tickMs: 60000, completionCheck: async input => {
    if (input.source === "heartbeat" && input.text === mandate) {
      observed = true;
      assert.ok(input.completionContext?.recent.some(m => m.role === "user" && m.text === mandate));
      return { state: "continue", next };
    }
    return { state: "completed" };
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await steerMandate(h, runtime);
    assert.ok(observed, "the host must independently assess the retained steered mandate");
    await h.submit(msg("Have you implemented it now?")); await h.drained();
    const task = h.snapshotSessions()[0].tasks!.find(t => t.original === mandate)!;
    assert.ok(task, "steering must not erase an accepted implementation request");
    assert.equal(task.state, "completed");
    assert.equal(runtime.sessions.get(key)!.prompts.filter(t => t.includes(next)).length, 1);
  } finally { await h.stop(0); }
});

for (const text of ["Thanks!", "What does this diagnostic mean?"]) {
  test(`steered informational input does not authorize coding: ${text}`, async () => {
    const runtime = new FakeRuntime(() => "Informational answer");
    const h = new Harness({ runtime, busyMode: "steer", tickMs: 60000,
      completionCheck: async () => ({ state: "completed" }) });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await steerMandate(h, runtime, text);
      assert.equal(runtime.sessions.get(key)!.prompts.length, 2, "no implementation follow-up");
      const retained = h.snapshotSessions()[0].tasks!.find(t => t.original === text)!;
      assert.ok(retained, "unknown result stays non-executable, not an invented coding mandate");
      assert.equal(retained.next, undefined);
      assert.equal(retained.lastReply, undefined, "another task's answer is not completion evidence");
    } finally { await h.stop(0); }
  });
}

test("steered mandate with missing assessment is retained without blind effect replay across JSON restart", async () => {
  const runtime = new FakeRuntime(() => "Not implemented");
  const h = new Harness({ runtime, busyMode: "steer", tickMs: 60000, completionCheck: async () => undefined });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await steerMandate(h, runtime);
    const snapshot = JSON.parse(JSON.stringify(h.snapshotSessions()));
    const task = snapshot[0].tasks.find((t: { original: string }) => t.original === mandate);
    assert.ok(task); assert.equal(task.state, "active"); assert.equal(task.lastReply, undefined);
    assert.equal(task.next, undefined, "prose is not an executable plan");
    const restoredRuntime = new FakeRuntime();
    const restored = new Harness({ runtime: restoredRuntime, tickMs: 60000, completionCheck: async () => undefined });
    restored.addChannel(new MemoryChannel()); restored.onStateChange = async () => {};
    try {
      restored.restoreSessions(snapshot); await restored.recoverTasks(); restored.releaseRestored(); await restored.drained();
      assert.equal(restoredRuntime.sessions.size, 0);
      assert.ok(restored.snapshotSessions()[0].tasks!.some(t => t.original === mandate));
    } finally { await restored.stop(0); }
  } finally { await h.stop(0); }
});
