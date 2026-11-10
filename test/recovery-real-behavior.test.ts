import test from "node:test";
import assert from "node:assert/strict";
import { Harness, type DurableTask } from "../src/harness.js";
import { assessCompletion } from "../src/completion-check.js";
import { completionStrategyHolder } from "../src/completion-strategy.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { runtimeReviewer } from "../src/runtime/reviewer.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
async function checker(output: string | Error, observed: string[] = []) {
  const strategy = await completionStrategyHolder("/tmp", undefined, { apiVersion: 1, prompt: completionPrompt }, undefined);
  const backend = runtimeReviewer(new FakeRuntime(prompt => {
    observed.push(prompt);
    if (output instanceof Error) throw output;
    return output;
  }));
  return (input: Parameters<typeof assessCompletion>[1], reply: string, signal: AbortSignal, diagnostic?: Parameters<typeof assessCompletion>[8]) =>
    assessCompletion(backend, input, reply, { task: input.completionAnchor!.task }, signal, undefined, Date.now, strategy.current, diagnostic);
}

for (const [request, reply] of [["Danke", "Gern."], ["Der Hostname lautet sample, nicht example.", "Verstanden: Der Hostname lautet sample."]]) {
  test(`actual strategy/adapter accepts answered nonactionable turn: ${request}`, async () => {
    const observed: string[] = [];
    const h = new Harness({ runtime: new FakeRuntime(() => reply), tickMs: 60000, completionCheck: await checker('{"state":"completed"}', observed) });
    const ch = new MemoryChannel(); h.addChannel(ch); h.onStateChange = async () => {};
    try {
      await h.submit(msg(request)); await h.drained(); await h.recoverTasks(); await h.tick(); await h.drained();
      assert.equal(h.snapshotSessions()[0].tasks![0].state, "completed");
      assert.equal(observed.length, 1);
      const data = JSON.parse(observed[0].split("DATA: ")[1]);
      assert.equal(data.request, request); assert.equal(data.reply, reply);
      assert.deepEqual(ch.texts(), [reply]);
    } finally { await h.stop(0); }
  });
}

test("valid semantic uncertainty is not a technical recovery retry, including normal turn", async () => {
  let turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { if (++turns > 1) h.planContinuation(key, { state: "completed" }); return "Result exists, verification is ambiguous."; }), tickMs: 60000, completionCheck: await checker('{"state":"uncertain"}') });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Verify the result")); await h.drained();
    const task = h.snapshotSessions()[0].tasks![0];
    assert.equal(task.recoveryRetry, undefined);
    assert.equal(task.state, "blocked", "uncertainty cannot admit working reconciliation");
    assert.equal(task.recoveryAdmission, undefined);
    assert.equal(turns, 1);
    await h.recoverTasks(); await h.tick();
    assert.equal(h.snapshotSessions()[0].tasks![0].recoveryRetry, undefined);
  } finally { await h.stop(0); }
});

test("startup uncertainty releases reservation without consuming existing technical budget", async () => {
  const task: DurableTask = { id: "retained", original: "Check existing result", lastReply: "Result retained", state: "active", depth: 0, recoveryRetry: { attempts: 1, nextAt: 0 } };
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, completionCheck: await checker('{"state":"uncertain"}') });
  h.addChannel(new MemoryChannel()); h.restoreSessions([{ key, task, replyTo: { channel: "mem", target: "room1" } }]); h.onStateChange = async () => {};
  try { await h.recoverTasks(); assert.equal(h.state(key).task!.recoveryRetry, undefined); assert.equal(h.state(key).task!.state, "blocked"); assert.match(h.state(key).task!.next!, /Independent supervisor admission unavailable/);
    assert.equal(h.pendingInputs().length, 0); }
  finally { await h.stop(0); }
});

for (const [output, category] of [[new Error("PRIVATE failure"), "technisch"], ["not JSON", "ungültige"], ["", "ungültige"]] as const) {
  test(`real wrapper failure retains evidence and deferred assessment for working reconciliation: ${category}/${String(output)}`, async () => {
    let now = Date.now();
    const h = new Harness({ runtime: new FakeRuntime(() => {
      h.planContinuation(key, { state: "blocked", next: "Registry authentication missing" });
      return "Existing PR is published; registry authentication missing.";
    }), now: () => now, tickMs: 60000, completionCheck: await checker(output) });
    const ch = new MemoryChannel(); h.addChannel(ch); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Deliver existing PR through GitOps")); await h.drained();
      for (let i = 1; i <= 5; i++) {
        await h.recoverTasks(); assert.equal(h.state(key).task!.recoveryRetry!.attempts, i);
        now = h.state(key).task!.recoveryRetry!.nextAt;
      }
      // Read-only assessments continue, but default-off diagnostics and productive fences remain.
      assert.equal(h.outboxEntries().length, 0);
      assert.match(h.state(key).task!.recoveryAttentionId!, /^task-recovery:/);
      const task = h.state(key).task!;
      assert.equal(task.termination, undefined);
      assert.equal(task.state, "active");
      assert.equal(task.next, undefined, "failed inference must not invent a next step");
      assert.equal(task.recoveryAdmission, undefined); assert.equal(h.pendingInputs().length, 0);
      assert.match(task.lastReply!, /registry authentication missing/i);
      assert.equal(task.recoveryRetry?.diagnostic, output instanceof Error ? "technical" : "invalid_response");
      assert.doesNotMatch(JSON.stringify(h.snapshotSessions()), /PRIVATE/);
      const snapshot = h.snapshotSessions();
      const restored = new Harness({ runtime: new FakeRuntime(() => { restored.planContinuation(key, { state: "blocked", next: "Registry authentication missing" }); return "Registry authentication missing"; }), tickMs: 60000 }); restored.addChannel(ch);
      restored.restoreSessions(snapshot); restored.restoreOutbox(h.outboxEntries()); restored.onStateChange = async () => {};
      try { await restored.recoverTasks(); restored.releaseRestored(); await restored.drained(); await restored.tick(); await restored.drained(); assert.equal(ch.texts().filter(t => t.includes("Recovery assessment paused:")).length, 0); assert.equal(restored.outboxEntries().length, 0); assert.equal(restored.state(key).task!.state, "blocked"); }
      finally { await restored.stop(0); }
    } finally { await h.stop(0); }
  });
}
