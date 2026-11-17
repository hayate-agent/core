import { test } from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { installCommands } from "../src/commands.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const explicit of [true, false]) test(`silent terminal rechecks are bounded and silent (checkpoint=${explicit})`, async () => {
  let turns = 0, checks = 0, h!: Harness;
  const ch = new MemoryChannel();
  Object.assign(ch, { editableProgress: true, turnStatus: async () => {}, turnEvent: () => {} });
  const runtime = new FakeRuntime(() => {
    turns++;
    if (explicit) h.planContinuation("mem:room1", { state: "completed" });
    return "NO_REPLY";
  });
  h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => {
    checks++; return { state: "continue", next: "Independently verify the completed result once more" };
  } });
  h.addChannel(ch); h.onStateChange = async () => {};
  try {
    await h.submit({ ...msg("Repair and verify"), progressId: "progress:original" }); await h.drained();
    const task = h.state("mem:room1").task!;
    assert.equal(turns, 2); assert.equal(checks, 2);
    assert.equal(ch.sent.length, 1, "the host must explain the stalled task, not publish a silent completion");
    assert.match(ch.sent[0]!.text, /continue/i);
    assert.doesNotMatch(ch.sent[0]!.text, /NO_REPLY/);
    assert.equal(task.state, "blocked", "do not ratify an unverified completion claim");
    assert.equal(task.supervisorDecision?.silentCompletionRecheck, "exhausted");
    assert.equal(task.recoveryRetry, undefined);
    const restored = new Harness({ runtime, tickMs: 60000, completionCheck: async () => { throw Error("held task must not recover automatically"); } });
    try {
      restored.restoreSessions(structuredClone(h.snapshotSessions()));
      restored.recoverTasks(); await restored.drained();
      assert.equal(turns, 2, "the bounded hold survives restart");
    } finally { await restored.stop(1000); }
  } finally { await h.stop(1000); }
});

test("silent continuation stalls early and is explicitly resumable", async () => {
  let turns = 0, h!: Harness;
  const runtime = new FakeRuntime(() => {
    turns++;
    h.planContinuation("mem:room1", { state: "continue", next: "Implement the outstanding change" });
    return "NO_REPLY";
  });
  h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => ({ state: "continue", next: "Implement the outstanding change" }) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Implement the requested change")); await h.drained();
    const task = h.state("mem:room1").task!;
    assert.equal(turns, 2);
    assert.equal(task.termination, "productive_budget_exhausted");
    assert.equal(task.explicitBlocked, false);
    assert.equal(task.next, "Implement the outstanding change");
    const { token } = h.taskBudgetStatus("mem:room1", task.id);
    await h.controlTaskBudget("mem:room1", task.id, "reset-resume", token, "operator-continue", "mem:owner");
    assert.equal(task.state, "active");
    assert.equal(task.repetition?.repetitions, 0);
    assert.equal(task.recoveryAdmission?.next, "Implement the outstanding change");
  } finally { await h.stop(1000); }
});

test("operator can resume a silent stall with Weiter and perform real work", async () => {
  let turns = 0, h!: Harness;
  const runtime = new FakeRuntime(() => {
    turns++;
    if (turns <= 2) {
      h.planContinuation("mem:room1", { state: "continue", next: "Implement the change" });
      return "NO_REPLY";
    }
    const event = runtime.sessions.get("mem:room1")!.options.at(-1)!.onEvent;
    event?.({ type: "tool", phase: "start", name: "edit" });
    event?.({ type: "tool", phase: "end", name: "edit", detail: "changed file" });
    h.planContinuation("mem:room1", { state: "completed" });
    return "Implemented the change";
  });
  const ch = new MemoryChannel();
  h = new Harness({ runtime, tickMs: 60000, completionCheck: async () => turns <= 2
    ? { state: "continue", next: "Implement the change" } : { state: "completed" } });
  h.addChannel(ch); h.onStateChange = async () => {};
  installCommands({ harness: h, admins: ["owner"], openAdmin: false, approvals: { mode: "off", tools: [] },
    agent: "test", skills: () => [], reloadSkills: async () => {}, restart: async () => {} });
  try {
    await h.accept({ ...msg("Implement the change", "owner"), id: "original" }); await h.drained();
    const task = h.state("mem:room1").task!;
    assert.equal(task.termination, "productive_budget_exhausted");
    await h.accept({ ...msg("Weiter", "owner"), id: "resume" });
    await h.recoverTasks(true); await h.drained();
    assert.equal(turns, 3, "same retained task runs productive work after operator continuation");
    assert.equal(task.state, "completed");
    assert.equal(task.budgetReceipts?.length, 1);
    assert.ok(ch.sent.some(message => message.text.includes("Implemented the change")));
  } finally { await h.stop(1000); }
});

test("silent terminal rechecks still permit real verification work", async () => {
  let turns = 0, h!: Harness;
  const ch = new MemoryChannel();
  const runtime = new FakeRuntime(() => {
    turns++;
    if (turns === 2) {
      const event = runtime.sessions.get("mem:room1")!.options.at(-1)!.onEvent;
      event?.({ type: "tool", phase: "start", name: "read" });
      event?.({ type: "tool", phase: "end", name: "read", detail: "verified deployed revision" });
    }
    h.planContinuation("mem:room1", { state: "completed" });
    return "NO_REPLY";
  });
  h = new Harness({ runtime, tickMs: 60000,
    completionCheck: async () => turns < 3 ? { state: "continue", next: "Verify remaining deployment evidence" } : { state: "completed" } });
  h.addChannel(ch); h.onStateChange = async () => {};
  try {
    await h.submit(msg("Repair and verify")); await h.drained();
    assert.equal(turns, 3, "real verification must not be mistaken for a no-work loop");
    assert.notEqual(h.state("mem:room1").task?.supervisorDecision?.silentCompletionRecheck, "exhausted");
    assert.equal(ch.sent.length, 0);
  } finally { await h.stop(1000); }
});

test("NO_REPLY with progress stays silent; substantive and failed replies retain delivery", async () => {
  for (const result of ["NO_REPLY", "Delivered and verified", "failure"]) {
    const ch = new MemoryChannel();
    const runtime = new FakeRuntime(() => { if (result === "failure") throw Error("backend failed"); return result; });
    const h = new Harness({ runtime, tickMs: 60000 }); h.addChannel(ch);
    try {
      await h.submit({ ...msg("hello"), progressId: "progress:original" }); await h.drained();
      assert.equal(ch.sent.length, result === "NO_REPLY" ? 0 : 1);
      if (result !== "NO_REPLY") {
        assert.equal(ch.sent[0]?.meta?.progressId, "progress:original");
        assert.match(ch.sent[0]!.text, result === "failure" ? /backend failed/ : /Delivered and verified/);
      }
    } finally { await h.stop(1000); }
  }
});
