import { confirmNonproductive } from "./fakes.js";
import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

function setup() {
  const runtime = new FakeRuntime();
  const h = new Harness({ completionCheck: confirmNonproductive, runtime, tickMs: 60000 });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", task: { id: "development", original: "Implement provider lifecycle", state: "active", next: "Test provider drain", depth: 2, recoveryAdmission: { id: "task:development:3", depth: 3, next: "Test provider drain", original: "Implement provider lifecycle" } }, replyTo: { channel: "mem", target: "room1" } }]);
  return { h, runtime };
}

test("intermediate question is answered before retained development task resumes", async () => {
  const { h, runtime } = setup();
  runtime.answer = (text, key) => {
    h.planContinuation(key, { state: "completed" });
    return text.includes("Next step:") ? "implementation finished" : "question answered";
  };
  try {
    await h.accept(msg("What version is the second agent running?")); await h.drained();
    const prompts = runtime.sessions.get("mem:room1")!.prompts;
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /second agent/); assert.match(prompts[1], /Test provider drain/);
    assert.equal(h.snapshotSessions()[0].tasks?.find(t => t.id === "development")?.state, "completed");
    await h.tick(); await h.tick(); await h.drained(); assert.equal(prompts.length, 2);
  } finally { await h.stop(1000); }
});

test("retained task survives a question with no continuation declaration and serialized restart", async () => {
  const { h, runtime } = setup();
  h.paused = true;
  await h.accept(msg("Which version?"));
  const snapshot = JSON.parse(JSON.stringify({ sessions: h.snapshotSessions(), pending: h.pendingInputs() }));
  await h.stop(0);
  const next = new Harness({ completionCheck: confirmNonproductive, runtime, tickMs: 60000 }); next.addChannel(new MemoryChannel()); next.onStateChange = async () => {};
  runtime.answer = (_text, key) => { next.planContinuation(key, { state: "completed" }); return "done"; };
  try {
    next.restoreSessions(snapshot.sessions); next.restorePending(snapshot.pending);
    await next.recoverTasks(); next.releaseRestored(); await next.drained();
    const prompts = runtime.sessions.get("mem:room1")!.prompts;
    assert.equal(prompts.length, 2); assert.match(prompts[1], /Test provider drain/);
  } finally { await next.stop(1000); }
});

test("missing plan retains active mandate for bounded independent assessment rather than inventing waiting", async () => {
  let checks = 0;
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async input => {
    checks++;
    assert.equal(input.completionAnchor?.task, "Implement feature");
    return checks === 2 ? { state: "continue", next: "Verify original work" } : undefined;
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  try {
    await h.accept(msg("Implement feature")); await h.drained();
    assert.equal(h.snapshotSessions()[0].task?.state, "active");
    runtime.answer = (_text, key) => { h.planContinuation(key, { state: "completed" }); return "done"; };
    // The startup assessment reuses the original authorization, once, durably.
    await h.tick(); await h.drained();
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 2);
    assert.match(runtime.sessions.get("mem:room1")!.prompts[1], /Verify original work/);
  } finally { await h.stop(1000); }
});

test("running worker prevents duplicate work; result keeps original mandate across intervening question", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "task-worker-"));
  const store = new ExecutionStore(path.join(home, "executions.json")); await store.load();
  const runtime = new FakeRuntime();
  const h = new Harness({ completionCheck: confirmNonproductive, runtime, executionStore: store, tickMs: 60000, hostEventAllowed: () => true });
  h.onStateChange = async () => {}; h.addChannel(new MemoryChannel());
  h.restoreSessions([{ key: "mem:room1", task: { id: "development", original: "Implement feature", state: "active", depth: 2, next: "Verify worker result" } }]);
  const execution = await store.submit("mem:room1", "worker", "implement", "direct", 1,
    { taskId: "development", original: "Implement feature", depth: 2 });
  const worker = await store.claim(execution.id);
  runtime.answer = (_text, key) => { h.planContinuation(key, { state: "completed" }); return "answered"; };
  try {
    await h.accept(msg("Which version?")); await h.drained(); await h.tick();
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
    await h.recoverTasks(); assert.equal(h.pendingInputs().length, 0);
    await store.complete(execution.id, worker.token!, "implementation done");
    const event = { id: "result", source: "host" as const, sessionKey: "mem:room1", text: "Worker result", hostEvent: { executionId: execution.id } };
    assert.equal(h.resultMandate(event)?.taskId, "development");
    await h.accept(event); await h.drained();
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 2);
    assert.equal(h.snapshotSessions()[0].tasks?.find(t => t.id === "development")?.state, "completed");
  } finally { await h.stop(1000); await rm(home, { recursive: true, force: true }); }
});

test("queued question prevents unassessed proposal execution but preserves proposed next", async () => {
  const runtime = new FakeRuntime(); const h = new Harness({ completionCheck: confirmNonproductive, runtime, tickMs: 60000, busyMode: "queue" });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  runtime.answer = (text, key) => {
    h.planContinuation(key, text === "Implement feature" ? { state: "continue", next: "Run original regression" } : { state: "completed" });
    return "done";
  };
  try {
    const session = await h.sessionFor("mem:room1"); const release = runtime.sessions.get("mem:room1")!.hold();
    await h.accept(msg("Implement feature"));
    await h.accept({ ...msg("Which version?"), id: "question" });
    release(); await h.drained();
    assert.equal(session.busy, false);
    const prompts = runtime.sessions.get("mem:room1")!.prompts;
    assert.equal(prompts.length, 2); assert.match(prompts[1], /Which version/);
    assert.equal(h.snapshotSessions()[0].tasks?.find(t => t.original === "Implement feature")?.next, "Run original regression");
  } finally { await h.stop(1000); }
});

test("failed checkpoint holds resumption without executing or duplicating it", async () => {
  const { h, runtime } = setup(); let offline = true;
  h.onStateChange = async () => { if (offline) throw Error("disk offline"); };
  try {
    await h.tick(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.sessions.size, 0); assert.equal(h.pendingInputs().length, 1);
    await h.tick(); assert.equal(h.pendingInputs().length, 1);
    runtime.answer = (_text, key) => { h.planContinuation(key, { state: "completed" }); return "done"; };
    offline = false; await h.tick(); await h.drained();
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
  } finally { await h.stop(0); }
});

test("pause and stop prevent retained task resumption", async () => {
  const { h, runtime } = setup();
  try {
    h.paused = true; await h.tick(); assert.equal(runtime.sessions.size, 0);
    await h.stopConversation("mem:room1"); h.paused = false; await h.tick(); await h.drained();
    assert.equal(runtime.sessions.size, 0);
    assert.ok(h.snapshotSessions()[0].tasks?.every(t => t.state === "stopped"));
  } finally { await h.stop(1000); }
});
