import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import type { OutboxEntry } from "../src/delivery/outbox.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "matrix:room";
function retained(): DurableTask {
  return { id: "retained", original: "PRIVATE_ORIGINAL_".repeat(400), lastReply: "PRIVATE_REPLY_".repeat(400),
    state: "active", depth: 2, expiresAt: Date.now() + 3600000,
    recoveryRetry: { attempts: 3, nextAt: 0, diagnostic: "technical" } };
}

for (const enabled of [undefined, false, true]) {
  test(`exhausted assessment obeys channel diagnostic policy ${enabled}, with no fourth attempt or worker`, async () => {
    let checks = 0;
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, tickMs: 60000,
      gateways: enabled === undefined ? undefined : { recoveryDiagnostics: true, overrides: { matrix: { recoveryDiagnostics: enabled } } },
      completionCheck: async () => { checks++; throw Error("PRIVATE_PROVIDER_ERROR"); } });
    const channel = new MemoryChannel(); Object.defineProperty(channel, "name", { value: "matrix" }); h.addChannel(channel);
    const original = retained(); h.restoreSessions([{ key, task: original, replyTo: { channel: "matrix", target: "room" } }]);
    h.onStateChange = async () => {};
    try {
      await h.recoverTasks(); await h.recoverTasks();
      const saved = h.snapshotSessions()[0].task!;
      assert.equal(saved.state, "blocked");
      assert.equal(saved.termination, "recovery_assessment_failed");
      assert.equal(saved.recoveryRetry?.attempts, 3);
      assert.equal(saved.original, original.original);
      assert.equal(saved.lastReply, original.lastReply);
      assert.equal(saved.expiresAt, original.expiresAt);
      assert.equal(saved.depth, 2);
      assert.equal(checks, 0); assert.equal(runtime.opened.length, 0); assert.equal(h.pendingInputs().length, 0);
      assert.equal(h.outboxEntries().length, enabled === true ? 1 : 0);
      if (enabled === true) {
        const entry = h.outboxEntries()[0]!;
        assert.match(entry.text, /^Recovery assessment paused:.*budget is exhausted \(technical\)/);
        assert.match(entry.text, /\/task-budget inspect/);
        assert.ok(entry.text.length < 600);
        assert.doesNotMatch(entry.text, /PRIVATE_|angehalten|Auftrag|Setze das Budget|⚠/);
      }
      const snapshot = JSON.parse(JSON.stringify(h.snapshotSessions()));
      const next = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, gateways: h.opts.gateways });
      next.addChannel(channel); next.restoreSessions(snapshot); next.restoreOutbox(h.outboxEntries()); next.onStateChange = async () => {};
      try {
        await next.recoverTasks(); next.releaseRestored(); await next.drained(); await next.tick(); await next.drained();
        assert.equal(channel.sent.length, enabled === true ? 1 : 0);
        assert.equal(next.state(key).task!.state, "blocked");
      } finally { await next.stop(0); }
    } finally { await h.stop(0); }
  });
}

for (const state of ["blocked", "completed", "stopped"] as const) {
  for (const enabled of [false, true]) {
    test(`upgrade: queued legacy diagnostic for ${state}, diagnostics ${enabled}, is silent or safely rewritten`, async () => {
      const task = retained(); task.state = state;
      task.recoveryAttentionId = `task-recovery-exhausted:${key}:${task.id}`;
      const legacy: OutboxEntry = { id: task.recoveryAttentionId, sessionKey: key, to: { channel: "mem", target: "room" },
        text: "⚠️ Recovery angehalten: exhausted\nAuftrag: PRIVATE_ORIGINAL\nUNVERIFIED EVIDENCE: PRIVATE_REPLY" };
      const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, gateways: { recoveryDiagnostics: enabled } });
      const channel = new MemoryChannel(); h.addChannel(channel);
      h.restoreSessions([{ key, task }]);
      let offline = true, saves = 0;
      h.onStateChange = async () => { saves++; if (offline) throw Error("disk unavailable"); };
      h.restoreOutbox([legacy, { ...legacy, id: "ordinary-result", text: "Verified result; do not discard." },
        { ...legacy, id: "ordinary-quoted-warning", text: "⚠️ Recovery angehalten: quoted user text must survive" },
        { ...legacy, id: "approval-request", text: "Approval required before deployment." }]);
      try {
        h.releaseRestored();
        for (let i = 0; i < 100 && !saves; i++) await new Promise(r => setTimeout(r, 5));
        assert.equal(channel.sent.length, 0, "failed migration save cannot release any delivery");
        assert.ok(saves > 0);
        offline = false; await h.tick(); await h.drained();
        const diagnostics = channel.sent.filter(e => e.meta?.deliveryId === legacy.id);
        assert.equal(diagnostics.length, enabled && state === "blocked" ? 1 : 0);
        if (diagnostics.length) {
          assert.match(diagnostics[0]!.text, /^Recovery assessment paused:/);
          assert.doesNotMatch(diagnostics[0]!.text, /PRIVATE_|angehalten|Auftrag|UNVERIFIED EVIDENCE/);
        }
        assert.ok(channel.texts().includes("Verified result; do not discard."));
        assert.ok(channel.texts().includes("⚠️ Recovery angehalten: quoted user text must survive"));
        assert.ok(channel.texts().includes("Approval required before deployment."));
        assert.equal(h.state(key).task!.state, state);
        assert.equal(h.state(key).task!.recoveryRetry?.attempts, 3);
        assert.equal(h.pendingInputs().length, 0);
      } finally { await h.stop(0); }
    });
  }
}
