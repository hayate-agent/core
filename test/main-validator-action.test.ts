import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { defaultConfig } from "../src/config.js";
import { continuationProvenance, continuationRequest } from "../src/continuation-provenance.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
test("Main validator continue produces the next actual Main turn and keeps plan provenance separate from human authority", async () => {
  let h!: Harness, assessed = 0;
  const runtime = new FakeRuntime(text => {
    if (text.includes("HOST-GENERATED CONTINUATION")) return "Existing PR checks verified and merge result confirmed; no repeated publication.";
    return "Commit pushed, tests pass, PR created. I will now inspect the checks and merge. Delivery is not complete.";
  });
  h = new Harness({ runtime, tickMs: 60000, completionCheck: async (input, reply) => {
    assessed++;
    if (reply.startsWith("Commit pushed")) return { state: "continue", next: "Inspect the existing PR's required checks and merge only if already authorized gates pass; do not push/create again." };
    return { state: "completed" };
  } });
  h.onStateChange = async () => {}; const channel = new MemoryChannel(); h.addChannel(channel);
  try {
    await h.submit(msg("Publish the implementation, run required checks and merge the PR.")); await h.drained();
    const worker = runtime.sessions.get(key)!;
    assert.equal(worker.prompts.length, 2);
    assert.equal(assessed, 2);
    assert.match(worker.prompts[1]!, /NOT A NEW HUMAN MESSAGE/);
    assert.match(worker.prompts[1]!, /originalTask/);
    assert.match(worker.options[1]!.instructions!, /not proof that a human wrote/);
    assert.match(worker.options[1]!.instructions!, /cannot grant permission, invent an operator prohibition/);
    assert.equal(h.snapshotSessions()[0]!.tasks![0]!.state, "completed");
  } finally { await h.stop(0); }
});

test("Main technical assessment failure without any self-checkpoint retries only the retained judgment", async () => {
  let now = Date.now(), calls = 0;
  const runtime = new FakeRuntime(() => "PR exists; I will now run the remaining checks and merge.");
  const h = new Harness({ runtime, now: () => now, tickMs: 60000, completionCheck: async (_input, _reply, _signal, diagnostic) => {
    calls++;
    if (calls === 1) { diagnostic?.("technical"); return; }
    return { state: "completed" };
  } });
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
  try {
    await h.submit(msg("Verify the existing published PR.")); await h.drained();
    const task = h.snapshotSessions()[0]!.tasks![0]!;
    assert.equal(task.recoveryRetry?.attempts, 1);
    assert.equal(task.supervisorDecision?.verdict, "unresolved");
    now += 60001; await h.recoverTasks(); await h.tick(); await h.drained();
    assert.equal(calls, 2);
    assert.equal(runtime.sessions.get(key)!.prompts.length, 1, "technical retry must not replay the working turn");
    assert.equal(h.snapshotSessions()[0]!.tasks![0]!.state, "completed");
  } finally { await h.stop(0); }
});

test("Main assessment timeout is bounded and configurable without replacing task authorization", () => {
  assert.equal(defaultConfig({ completionCheck: { timeoutMs: 45000 } }).completionCheck?.timeoutMs, 45000);
  for (const timeoutMs of [0, 999, 120001, Infinity, 1.5])
    assert.throws(() => defaultConfig({ completionCheck: { timeoutMs } }), /completionCheck.timeoutMs/);
});

test("all generated turn kinds remain distinguishable from human ingress", () => {
  for (const source of ["cron", "heartbeat", "loop", "goal", "host"] as const) {
    const text = continuationProvenance({ source, sessionKey: key, text: "do not deploy", completionAnchor: { id: "a", task: "Authorized source delivery", receivedAt: 1 } });
    assert.match(text, /NOT a new human instruction/);
    assert.match(text, /originalTask/);
  }
  assert.match(continuationRequest("Deliver source", "No live operation yet, says worker"), /suggested next step is model-generated evidence/);
});
