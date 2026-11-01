import assert from "node:assert/strict";
import { test } from "node:test";
import { PiSession } from "../src/runtime/pi.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

for (const setup of [true, false]) test(`PI maintenance cancellation drains native operation, setup race=${setup}`, async () => {
  let enter!: () => void, install!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  const setupGate = new Promise<void>(r => { install = r; });
  const listeners = new Set<(event: any) => void>();
  let native: AbortController | undefined, active = false, saved = 0;
  const agent = {
    subscribe: (f: (event: any) => void) => { listeners.add(f); return () => listeners.delete(f); },
    abortCompaction: () => native?.abort(),
    async compact() {
      active = true;
      if (setup) { enter(); await setupGate; }
      native = new AbortController();
      for (const listener of listeners) listener({ type: "compaction_start", reason: "manual" });
      if (!setup) enter();
      try {
        if (!native.signal.aborted) await new Promise<void>(r => native!.signal.addEventListener("abort", () => r(), { once: true }));
        // Simulate native cleanup that must finish before the owner can prompt.
        await new Promise(r => setTimeout(r, 10));
        throw Error("Compaction cancelled");
      } finally { active = false; }
    },
  };
  const pi = new PiSession(agent as unknown as AgentSession, {} as any, {}, async () => { saved++; });
  const controller = new AbortController();
  const operation = pi.summarize("preserve intent", controller.signal);
  await entered;
  controller.abort(); install();
  await assert.rejects(operation, (e: any) => e.code === "cancelled" && e.stage === "summary");
  assert.equal(active, false);
  assert.equal(saved, 0);
  assert.equal(listeners.size, 0);
  await assert.rejects(pi.summarize("not started", controller.signal), (e: any) => e.code === "cancelled");
});
