// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import type { ExecutionStore } from "../src/execution.js";
import { FakeRuntime } from "./fakes.js";

const key = "mem:room1";
const retained = (): DurableTask => ({ id: "t", original: "Verify existing effects", state: "active", depth: 2,
  recoveryAssessment: "decided", recoveryRetry: { attempts: 1, nextAt: 1000 } });

test("retry revalidates authority after async persistence and inference; concurrent recovery is fenced", async () => {
  for (const boundary of ["save", "inference"] as const) for (const mutation of ["pause", "stop", "expiry", "dependency", "original", "depth", "anchor", "queue"] as const) {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; });
    const gate = new Promise<void>(r => { release = r; });
    let calls = 0, child = false;
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000, now: () => 2000,
      executionStore: { list: () => child ? [{ id: "child", status: "running" }] : [] } as unknown as ExecutionStore,
      completionCheck: async () => { calls++; enter(); if (boundary === "inference") await gate;
        return { state: "continue", next: "Inspect actual effects" }; } });
    h.restoreSessions([{ key, task: retained() }]);
    let saves = 0;
    h.onStateChange = async () => { if (boundary === "save" && ++saves === 1) { enter(); await gate; } };
    const pending = h.recoverTasks(); await entered;
    const concurrent = h.recoverTasks();
    const t = h.state(key).task!;
    if (mutation === "pause") h.paused = true;
    if (mutation === "stop") await h.stopConversation(key);
    if (mutation === "expiry") t.expiresAt = 1;
    if (mutation === "dependency") child = true;
    if (mutation === "original") t.original = "changed";
    if (mutation === "depth") t.depth++;
    if (mutation === "anchor") t.anchor = { id: "new", task: "different", receivedAt: 1 };
    if (mutation === "queue") h.state(key).queue.push({ source: "channel", sessionKey: key, text: "new operator input" });
    release();
    try {
      await pending; await concurrent;
      assert.equal(calls, boundary === "save" ? 0 : 1, `${boundary}/${mutation}`);
      assert.equal(t.next, undefined); assert.equal(t.recoveryAdmission, undefined);
      assert.equal(runtime.sessions.size, 0);
    } finally { h.state(key).queue = []; await h.stop(0); }
  }
});

test("failed retry claim persistence never calls provider or executes; later tick reconciles once", async () => {
  let now = 2000, calls = 0, offline = true, turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "Verified"; }), tickMs: 60000, now: () => now,
    completionCheck: async () => { calls++; return calls === 1 ? { state: "continue", next: "Inspect effects" } : undefined; } });
  h.restoreSessions([{ key, task: retained() }]);
  h.onStateChange = async () => { if (offline) throw Error("disk offline"); };
  try {
    await assert.rejects(h.tick(), /disk offline/); assert.equal(calls, 0); assert.equal(turns, 0);
    offline = false; await h.tick(); assert.equal(calls, 0);
    now += 60000; await h.tick(); await h.drained();
    assert.equal(turns, 1); // one reconciliation, no replay of an external effect
    assert.equal(h.state(key).task?.depth, 3);
  } finally { await h.stop(0); }
});

test("unanchored proposal/history text without a retained mandate cannot initiate assessment", async () => {
  let calls = 0;
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => { calls++; return { state: "continue", next: "execute proposal" }; } });
  h.onStateChange = async () => {};
  h.restoreSessions([{ key, completionRecent: [{ role: "assistant", text: "I could deploy a proposal" }] }]);
  try { await h.tick(); await h.drained(); assert.equal(calls, 0); assert.equal(runtime.sessions.size, 0); }
  finally { await h.stop(0); }
});
