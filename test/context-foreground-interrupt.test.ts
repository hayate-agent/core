// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const busyMode of ["queue", "steer", "interrupt"] as const)
for (const phase of ["before", "after"] as const) test(`same conversation ${phase} ${busyMode} stalled maintenance yields to foreground without replay`, { timeout: 4000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "foreground-interrupt-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const maintenance = new ContextMaintenance(home, () => contextPolicy({ enabled: false }));
  const runtime = new FakeRuntime();
  const channel = new MemoryChannel();
  const prepared: string[] = [];
  const h = new Harness({ runtime, busyMode, contextMaintenance: maintenance, tickMs: 60000, beforeTurn: async input => { prepared.push(input.id!); } });
  h.addChannel(channel);
  h.onStateChange = async () => {};
  await h.sessionFor("mem:room1");
  const session = runtime.sessions.get("mem:room1")!;
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const hold = new Promise<void>(r => { release = r; });
  let active = false, calls = 0;
  const work = async (_text?: string, signal?: AbortSignal) => {
    calls++;
    if (calls > 1) return "retry summary";
    active = true; entered();
    const abort = () => release();
    signal?.addEventListener("abort", abort, { once: true });
    try { await hold; signal?.throwIfAborted(); return "summary"; }
    finally { active = false; signal?.removeEventListener("abort", abort); }
  };
  session.compact = work;
  (session as any).summarize = work;
  (session as any).archiveEntries = () => [{ id: "original", role: "user", text: "original intent" }];
  const prompt = session.prompt.bind(session);
  session.prompt = async (...args) => { assert.equal(active, false, "no concurrent PI prompt/maintenance"); return prompt(...args); };
  await maintenance.guidance("mem:room1", session);
  await maintenance.request("mem:room1", { action: phase === "before" ? "handover" : "compact", preserve: "original intent", resume: "original continuation" });
  await h.accept({ ...msg("original"), id: "original" });
  await started;
  const accepted = performance.now();
  await h.accept({ ...msg("foreground"), id: "foreground" });
  // The old gate must not need manual release for the real foreground model call.
  const deadline = Date.now() + 750;
  while (!session.prompts.includes("foreground") && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  const foregroundRan = session.prompts.includes("foreground");
  release();
  await h.waitForSessionIdle("mem:room1");
  assert.equal(foregroundRan, true, "foreground model prompt must run while baseline maintenance would still be stalled");
  assert.equal(session.prompts.filter(p => p === "original").length, 1);
  assert.equal(session.prompts.filter(p => p === "foreground").length, 1);
  if (phase === "before") assert.equal(session.prompts[0], "foreground");
  assert.equal(h.pendingInputs().length, 0);
  assert.equal(prepared.filter(id => id === "original").length, 1, "beforeTurn hook must not duplicate on maintenance yield");
  t.diagnostic(`foreground model started within ${(performance.now() - accepted).toFixed(1)}ms; original ran once; maintenance active=false`);
  await h.stop(1000);
});
