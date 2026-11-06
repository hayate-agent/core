// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { assessCompletion } from "./completion-default.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const mandate = "Implement the approved update and verify regressions. No deployment.";

for (const preparation of ["compact", "handover"] as const)
for (const failure of [false, true]) {
  test(`startup prepares ${preparation} before recovered work; failure=${failure}`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "startup-context-"));
    const events: string[] = [];
    const persisted: Array<{ sessions: ReturnType<Harness["snapshotSessions"]>; pending: ReturnType<Harness["pendingInputs"]> }> = [];
    const runtime = new FakeRuntime(text => {
      events.push("work");
      assert.match(text, /No deployment/);
      assert.match(text, /First reconcile/);
      return "Remaining regressions verified without deployment";
    });
    const open = runtime.open.bind(runtime);
    runtime.open = async (key, options) => {
      const session = await open(key, options);
      const status = session.status.bind(session);
      session.status = () => ({ ...status(), sessionId: options?.fresh ? "new" : "old" });
      session.compact = async instructions => {
        events.push("compact"); assert.match(instructions!, /No deployment/);
        if (failure) throw Error("compaction failed");
      };
      session.summarize = async instructions => {
        events.push("summary"); assert.match(instructions, /No deployment/);
        if (failure) throw Error("summary failed");
        return "Verified update. CURRENT STATE AND NEXT STEPS: Run remaining regression. No deployment.";
      };
      session.archiveEntries = () => [{ id: "operator", role: "user", text: mandate },
        { id: "effect", role: "assistant", text: "Update verified; do not replay" }];
      session.seedHandover = async text => {
        events.push("seed"); assert.match(text, /No deployment/); assert.match(text, /Archive ID:/);
      };
      return session;
    };
    const maintenance = new ContextMaintenance(home, () => contextPolicy());
    const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: maintenance,
      completionCheck: async input => {
        assert.equal(input.completionAnchor?.task, mandate);
        events.push("check");
        return events.includes("work") ? { state: "completed" } : {
          state: "continue", next: "Verify remaining regression without replaying update", contextPreparation: preparation,
        };
      } });
    h.addChannel(new MemoryChannel());
    h.restoreSessions([{ key: "mem:room1", replyTo: { channel: "mem", target: "room1" }, task: {
      id: "retained", original: mandate, state: "active", depth: 2,
      lastReply: "Update verified; context exhausted before regression verification",
    } }]);
    h.onStateChange = async () => {
      persisted.push(JSON.parse(JSON.stringify({ sessions: h.snapshotSessions(), pending: h.pendingInputs() })));
    };
    try {
      await h.recoverTasks();
      assert.deepEqual(events, ["check"], "startup must persist recovery before releasing work");
      h.releaseRestored(); await h.drained();
      assert.deepEqual(events, ["check", ...(preparation === "compact" ? ["compact"] : failure ? ["summary"] : ["summary", "seed"]),
        ...(failure ? [] : ["work", "check"])]);
      const queued = persisted.find(state => state.pending.some(input => input.taskId === "retained"));
      assert.ok(queued, "recovered input must be durably queued");
      assert.equal(queued.pending[0].contextPreparation, preparation);
      assert.equal(queued.pending[0].completionAnchor?.task, mandate);
      assert.equal(queued.sessions[0].task?.original, mandate);
      assert.equal(queued.sessions[0].task?.contextPreparation, preparation);
      assert.equal(h.snapshotSessions()[0].task?.original, mandate);
      if (failure) {
        assert.equal(runtime.sessions.get("mem:room1")?.prompts.length, 0);
        const saved = await maintenance.status("mem:room1");
        assert.equal(saved.continuationPreparationRequired, true);
        assert.equal(saved.pending?.action, preparation);
      } else assert.equal(h.snapshotSessions()[0].task?.state, "completed");
    } finally { await h.stop(0); await rm(home, { recursive: true, force: true }); }
  });
}

for (const preparation of ["compact", "handover", undefined] as const)
for (const failure of [false, true]) {
  if (!preparation && failure) continue;
  test(`semantic WAIT override prepares ${preparation ?? "no maintenance"} before work; failure=${failure}`, async () => {
    let now = 1000;
    const home = await mkdtemp(path.join(os.tmpdir(), "semantic-context-"));
    const events: string[] = [];
    let turns = 0;
    const runtime = new FakeRuntime((_text, key) => {
      events.push(`work-${++turns}`);
      h.planContinuation(key, turns === 1 ? { state: "waiting", next: "I cannot continue with this context", wait: {
        reason: "Context exhausted", retryAfterMs: 60000, deadline: Date.now() + 300000,
      } } : { state: "completed" });
      return turns === 1 ? "Context exhausted; regression remains. Verified update must not be replayed." : "Regressions verified";
    });
    const open = runtime.open.bind(runtime);
    runtime.open = async (key, options) => {
      const session = await open(key, options);
      const status = session.status.bind(session);
      session.status = () => ({ ...status(), sessionId: options?.fresh ? "new" : "old" }); // unknown usage, no threshold guarantee
      session.compact = async instructions => {
        events.push("compact"); assert.match(instructions!, /No deployment/);
        if (failure) throw Error("compaction failed");
      };
      session.summarize = async instructions => {
        events.push("summary"); assert.match(instructions, /No deployment/);
        if (failure) throw Error("summary failed");
        return "Verified update. CURRENT STATE AND NEXT STEPS: Run remaining regression. No deployment.";
      };
      session.archiveEntries = () => [{ id: "operator", role: "user", text: mandate },
        { id: "effect", role: "assistant", text: "Verified update must not be replayed" }];
      session.seedHandover = async text => { events.push("seed"); assert.match(text, /No deployment/); assert.match(text, /Archive ID:/); };
      return session;
    };
    const maintenance = new ContextMaintenance(home, () => contextPolicy(), async () => {
      throw Error("unknown usage must not invent a threshold assessment");
    }, () => now);
    const h = new Harness({ runtime, tickMs: 60000, contextMaintenance: maintenance,
      completionCheck: (input, reply, signal) => assessCompletion({ review: async () => {
        events.push("check");
        return JSON.stringify(turns === 1 ? { state: "continue", next: "Run remaining authorized regression", contextPreparation: preparation } : { state: "completed" });
      } }, input, reply, input.completionAnchor ? { task: input.completionAnchor.task } : undefined, signal) });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg(mandate)); await h.drained();
      assert.equal(turns, failure ? 1 : 2, "required preparation failure must not execute a working prompt");
      assert.deepEqual(events, ["work-1", "check", ...(preparation === "compact" ? ["compact"] : preparation === "handover" ? failure ? ["summary"] : ["summary", "seed"] : []), ...(failure ? [] : ["work-2", "check"])]);
      const task = h.snapshotSessions()[0].task!;
      assert.equal(task.original, mandate); assert.equal(task.wait, undefined);
      if (!failure) assert.equal(task.state, "completed");
      else {
        const saved = await maintenance.status("mem:room1");
        assert.equal(saved.continuationPreparationRequired, true);
        assert.equal(saved.pending?.action, preparation);
        // A later recovery/new turn must not bypass the failed prerequisite during cooldown.
        const restarted = new ContextMaintenance(home, () => contextPolicy(), undefined, () => now);
        await assert.rejects(restarted.beforeTurn("mem:room1", runtime.sessions.get("mem:room1")!, async () => {
          throw Error("must not rotate during cooldown");
        }), /Context maintenance/);
        assert.equal(turns, 1);
        now += 60001;
        const retry = new ContextMaintenance(home, () => contextPolicy(), undefined, () => now);
        const old = runtime.sessions.get("mem:room1")!;
        old.compact = async () => {};
        old.summarize = async () => "CURRENT STATE AND NEXT STEPS: Run regression. No deployment.";
        await retry.beforeTurn("mem:room1", old, async handover => {
          const next = await runtime.open("mem:room1", { fresh: true });
          await next.seedHandover!(handover!.text); return next;
        });
        assert.equal((await retry.status("mem:room1")).pending, undefined);
        assert.equal((await retry.status("mem:room1")).continuationPreparationRequired, undefined);
      }
      if (preparation && !failure) {
        const state = await maintenance.status("mem:room1");
        assert.equal(state.failure, undefined); assert.equal(state.pending, undefined);
        if (preparation === "handover") {
          assert.equal(state.handover?.phase, "switched");
          assert.equal(state.handover?.from, "old"); assert.equal(state.handover?.to, "new");
          assert.ok(state.handover?.archiveId);
        }
      }
    } finally { await h.stop(0); await rm(home, { recursive: true, force: true }); }
  });
}
