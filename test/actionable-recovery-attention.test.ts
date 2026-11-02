import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness, type DurableTask } from "../src/harness.js";
import { StateStore } from "../src/state.js";
import { assessCompletion } from "./completion-default.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
test("answered informational turn with independent completed verdict stays complete across recovery", async () => {
  let checks = 0;
  const runtime = new FakeRuntime(() => "Vier.");
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: (input, reply, signal) =>
    assessCompletion({ review: async () => { checks++; assert.equal(reply, "Vier."); return '{"state":"completed"}'; } },
      input, reply, { task: input.completionAnchor!.task }, signal) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Was ist zwei plus zwei?")); await h.drained();
    assert.equal(h.state(key).task?.state, "completed");
    await h.recoverTasks(); await h.tick(); await h.drained();
    assert.equal(checks, 1); assert.deepEqual(channel.texts(), ["Vier."]);
    const restored = new Harness({ runtime: new FakeRuntime(), tickMs: 60000,
      completionCheck: async () => { throw Error("completed turn must not be reassessed"); } });
    restored.addChannel(channel); restored.onStateChange = async () => {};
    try {
      restored.restoreSessions(JSON.parse(JSON.stringify(h.snapshotSessions())));
      await restored.recoverTasks(); restored.releaseRestored(); await restored.tick(); await restored.drained();
      assert.equal(restored.state(key).task?.state, "completed");
      assert.deepEqual(channel.texts(), ["Vier."]);
    } finally { await restored.stop(0); }
  } finally { await h.stop(0); }
});

for (const mode of ["interrupted", "unavailable", "inconclusive", "failed", "mismatched", "invalid", "exhausted", "technical", "parse", "technical-saved", "parse-saved"] as const) {
  test(`${mode}: actionable notice crosses disk/restart/delivery barriers once without raw diagnostics`, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "actionable-recovery-"));
    const store = new StateStore(path.join(home, "state.json"));
    const channel = new MemoryChannel();
    const task: DurableTask = { id: "retained", original: "Was ist mit Deinem Self-Improvement?!", state: "active", depth: 2 };
    if (mode === "interrupted") task.recoveryAssessment = "claimed";
    // Exhausted assessments reconcile through working execution, not attention.
    if (mode === "inconclusive" || mode === "failed")
      task.recoveryRetry = { attempts: 2, nextAt: 0 };
    if (mode === "invalid" || mode === "exhausted") task.recoveryRetry = { attempts: mode === "invalid" ? 0 : 3, nextAt: 0 };
    if (mode === "technical" || mode === "parse") task.recoveryRetry = { attempts: 2, nextAt: 0 };
    if (mode === "technical-saved" || mode === "parse-saved") {
      task.recoveryAssessment = "decided";
      task.recoveryRetry = { attempts: 3, nextAt: 0, diagnostic: mode === "technical-saved" ? "technical" : "invalid_response" };
    }
    if (mode === "mismatched") {
      task.next = "Verify existing effects";
      task.recoveryAssessment = "decided";
      task.recoveryAdmission = { id: "task:retained:3", depth: 3, next: "different", original: task.original };
    }
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000, ...(mode === "unavailable" ? {} : { completionCheck: async (input, reply, signal, diagnostic) => {
      assert.notEqual(mode, "invalid"); assert.notEqual(mode, "exhausted");
      assert.notEqual(mode, "technical-saved"); assert.notEqual(mode, "parse-saved");
      if (mode === "technical" || mode === "parse") return assessCompletion({ review: async () => {
        if (mode === "technical") throw Error("PRIVATE_PROVIDER_TOKEN raw provider error");
        return "PRIVATE_PROVIDER_TOKEN invalid JSON";
      } }, input, reply, { task: input.completionAnchor!.task }, signal, undefined, undefined, undefined, diagnostic);
      if (mode === "failed") throw Error("PRIVATE_PROVIDER_TOKEN raw provider error");
      return undefined;
    } }) });
    h.addChannel(channel);
    await store.save({ version: 1, paused: false, busyMode: "queue", sessions: [{ key, task, replyTo: { channel: "mem", target: "room1" } }] });
    h.restoreSessions((await store.load())!.sessions);
    let offline = true;
    const save = () => store.save({ version: 1, paused: false, busyMode: "queue", sessions: h.snapshotSessions(), pending: h.pendingInputs(), outbox: h.outboxEntries() });
    h.onStateChange = async () => { if (offline) throw Error("disk unavailable"); await save(); };
    let next: Harness | undefined;
    try {
      // Persist the assessment claim first; fail the subsequent recovery barrier.
      if (["inconclusive", "failed", "technical", "parse"].includes(mode)) {
        h.onStateChange = async () => {
          if (h.state(key).task?.recoveryAssessment === "claimed") await save();
          else if (offline) throw Error("disk unavailable"); else await save();
        };
      }
      await assert.rejects(h.recoverTasks(), /disk unavailable/);
      assert.equal(channel.sent.length, 0);
      assert.equal(h.pendingInputs().length, 0);
      if (mode !== "invalid" && mode !== "mismatched") {
        assert.equal(h.state(key).task!.state, "blocked");
        assert.match(h.state(key).task!.next!, /Independent supervisor admission unavailable/);
        assert.equal(h.state(key).task!.recoveryAdmission, undefined);
        assert.equal(h.outboxEntries().length, 0);
        offline = false; await save();
        const checkpoint = (await store.load())!;
        const saved = checkpoint.sessions[0]!.task!;
        assert.equal(saved.state, "blocked");
        if (mode === "technical" || mode === "parse") {
          assert.equal(saved.recoveryRetry?.attempts, 3);
          assert.equal(saved.recoveryRetry?.diagnostic, mode === "technical" ? "technical" : "invalid_response");
        }
        assert.doesNotMatch(JSON.stringify(checkpoint), /PRIVATE_PROVIDER_TOKEN|raw provider error/);
        let turns = 0;
        next = new Harness({ runtime: new FakeRuntime(() => { turns++; return "Receipt verified"; }), tickMs: 60000,
          completionCheck: async () => ({ state: "completed" }) }); next.addChannel(channel);
        next.restoreSessions(checkpoint.sessions); next.restorePending(checkpoint.pending ?? []);
        next.onStateChange = () => store.save({ ...checkpoint, sessions: next!.snapshotSessions(), pending: next!.pendingInputs() });
        await next.recoverTasks();
        assert.equal(next.pendingInputs().length, 0);
        next.releaseRestored(); await next.drained();
        await next.tick(); await next.drained();
        assert.equal(turns, 0);
        assert.equal(next.state(key).task!.state, "blocked");
        return;
      }
      assert.equal(h.outboxEntries().length, 1);
      const notice = h.outboxEntries()[0]!;
      assert.match(notice.text, /Auftrag: Was ist mit Deinem Self-Improvement/);
      assert.match(notice.text, /Verifizierter Stand:/);
      assert.match(notice.text, /Abschluss ist nicht unabhängig bestätigt/);
      assert.doesNotMatch(notice.text, /Entscheidung nötig:|Bitte antworte|konkreten nächsten Schritt|Ohne diese Klärung/);
      assert.doesNotMatch(notice.text, /PRIVATE_PROVIDER_TOKEN|raw provider error|fehlende Berechtigung|operator reconciliation required/);
      const reason = { interrupted: /unterbrochen/, unavailable: /nicht konfiguriert/, inconclusive: /drei Recovery-Bewertungsversuche/, failed: /fehlgeschlagen/, mismatched: /passt nicht/, invalid: /Retryzustand ist ungültig/, exhausted: /drei Recovery-Bewertungsversuche/, technical: /technisch fehlgeschlagen/, parse: /ungültige Antwort/, "technical-saved": /technisch fehlgeschlagen/, "parse-saved": /ungültige Antwort/ }[mode];
      assert.match(notice.text, reason);
      if (mode === "invalid") assert.doesNotMatch(notice.text, /ausgeschöpft|drei Recovery-Bewertungsversuche/);
      offline = false; await save();
      const checkpoint = (await new StateStore(store.file).load())!;
      assert.equal(checkpoint.sessions[0]!.task!.state, "blocked");
      const savedRetry = checkpoint.sessions[0]!.task!.recoveryRetry;
      if (mode === "technical" || mode === "parse") {
        assert.equal(savedRetry?.attempts, 3);
        assert.equal(savedRetry?.diagnostic, mode === "technical" ? "technical" : "invalid_response");
      }
      assert.equal(checkpoint.sessions[0]!.task!.depth, 2);
      assert.doesNotMatch(JSON.stringify(checkpoint), /PRIVATE_PROVIDER_TOKEN|raw provider error/);
      assert.equal(checkpoint.outbox![0]!.id, notice.id);
      next = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); next.addChannel(channel);
      next.restoreSessions(checkpoint.sessions); next.restorePending(checkpoint.pending ?? []); next.restoreOutbox(checkpoint.outbox ?? []);
      next.onStateChange = () => store.save({ ...checkpoint, sessions: next!.snapshotSessions(), pending: next!.pendingInputs(), outbox: next!.outboxEntries() });
      await next.recoverTasks(); next.releaseRestored(); await next.drained();
      await next.tick(); await next.drained();
      assert.equal(channel.sent.length, 1); assert.equal(channel.sent[0]!.meta?.deliveryId, notice.id);
      // Delivery schedules its receipt save asynchronously. Queue a durable
      // snapshot behind it before inspecting disk or removing the fixture.
      await next.onStateChange!();
      assert.equal((await store.load())!.outbox!.length, 0);
      assert.equal(runtime.sessions.size, 0);
    } finally {
      h.onStateChange = async () => {}; if (next) next.onStateChange = async () => {};
      await h.stop(0); await next?.stop(0);
      await store.save({ version: 1, paused: false, busyMode: "queue", sessions: [] });
      await rm(home, { recursive: true, force: true });
    }
  });
}
