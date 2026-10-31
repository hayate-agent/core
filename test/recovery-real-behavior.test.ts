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

for (const [request, reply] of [["Danke", "Gern."], ["Der Hostname lautet snape, nicht severus.", "Verstanden: Der Hostname lautet snape."]]) {
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
  const h = new Harness({ runtime: new FakeRuntime(() => "Result exists, verification is ambiguous."), tickMs: 60000, completionCheck: await checker('{"state":"uncertain"}') });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Verify the result")); await h.drained();
    const task = h.snapshotSessions()[0].tasks![0];
    assert.equal(task.recoveryRetry, undefined);
    assert.equal(task.state, "blocked", "uncertainty must not become automatic technical retries");
    await h.recoverTasks(); await h.tick();
    assert.equal(h.snapshotSessions()[0].tasks![0].recoveryRetry, undefined);
  } finally { await h.stop(0); }
});

test("startup uncertainty releases reservation without consuming existing technical budget", async () => {
  const task: DurableTask = { id: "retained", original: "Check existing result", lastReply: "Result retained", state: "active", depth: 0, recoveryRetry: { attempts: 1, nextAt: 0 } };
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, completionCheck: await checker('{"state":"uncertain"}') });
  h.addChannel(new MemoryChannel()); h.restoreSessions([{ key, task, replyTo: { channel: "mem", target: "room1" } }]); h.onStateChange = async () => {};
  try { await h.recoverTasks(); assert.equal(h.state(key).task!.recoveryRetry?.attempts, 1); assert.equal(h.state(key).task!.state, "blocked"); }
  finally { await h.stop(0); }
});

for (const [output, category] of [[new Error("PRIVATE failure"), "technisch"], ["not JSON", "ungültige"], ["", "ungültige"]] as const) {
  test(`real wrapper failure retains blocker evidence and technical bound: ${category}/${String(output)}`, async () => {
    let now = Date.now();
    const h = new Harness({ runtime: new FakeRuntime(() => {
      h.planContinuation(key, { state: "blocked", next: "Registry authentication missing" });
      return "Existing PR is published; registry authentication missing.";
    }), now: () => now, tickMs: 60000, completionCheck: await checker(output) });
    const ch = new MemoryChannel(); h.addChannel(ch); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Deliver existing PR through GitOps")); await h.drained();
      for (let i = 1; i <= 3; i++) { await h.recoverTasks(); assert.equal(h.state(key).task!.recoveryRetry!.attempts, i); now += 60001; }
      const notice = h.outboxEntries()[0];
      assert.ok(notice); assert.match(notice.text, new RegExp(category));
      assert.match(notice.text, /UNVERIFIED EVIDENCE/); assert.match(notice.text, /registry authentication missing/i);
      assert.doesNotMatch(notice.text, /Entscheidung nötig|Bitte antworte|Soll dieser Auftrag|PRIVATE/);
      const snapshot = h.snapshotSessions();
      const restored = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); restored.addChannel(ch);
      restored.restoreSessions(snapshot); restored.restoreOutbox(h.outboxEntries()); restored.onStateChange = async () => {};
      try { await restored.recoverTasks(); restored.releaseRestored(); await restored.drained(); await restored.tick(); await restored.drained(); assert.equal(ch.texts().filter(t => t.includes("Recovery angehalten")).length, 1); }
      finally { await restored.stop(0); }
    } finally { await h.stop(0); }
  });
}
