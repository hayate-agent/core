import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { Subagents, type SubagentRecord } from "../src/subagents.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
const handover = { task: "Read rules", context: "Read-only", constraints: "No writes", expectedResult: "Evidence", acceptance: "Exact result", model: "fixture/model", thinking: "off" };

for (const outcome of [undefined, "failed", "early-completed"] as const) test(`native child ${outcome ?? "success"} wakes the exact parent without dispatcher or polling`, async () => {
  let children!: Subagents, childId = "", parentTurns = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const runtime = new FakeRuntime(async (_text, sessionKey) => {
    if (sessionKey.startsWith("subagent:")) { await held; if (outcome === "failed") throw Error("Exact retained child evidence"); return "Exact retained child evidence"; }
    parentTurns++;
    if (parentTurns === 1) {
      const r = await children.start(key, handover); childId = r.id;
      h.planContinuation(key, { state: outcome === "early-completed" ? "completed" : "waiting", next: "Use child evidence" });
      return "Waiting for the existing child";
    }
    assert.equal(h.sessions.get(key)!.current!.taskId, "original");
    assert.match(h.sessions.get(key)!.current!.text, /Exact retained child evidence/);
    h.planContinuation(key, { state: "completed" }); return "Verified child result";
  });
  const h = new Harness({ runtime, tickMs: 600000,
    hostEventAllowed: i => !!children.resultExecution(i), nativeSubagentExecution: i => children.resultExecution(i),
    pendingNativeSubagent: (parent, id) => children.pending(parent, id),
    completionCheck: async input => input.source === "host" || outcome === "early-completed" ? { state: "completed" } : { state: "waiting" } });
  children = new Subagents(h, async () => {}); h.addChannel(new MemoryChannel()); h.addChannel(children.channel); h.onStateChange = async () => {};
  try {
    await h.accept({ ...msg("Read the rules through a child"), id: "original" });
    // Wait only for the deterministic parent turn, not for a timer/model poll.
    while (!childId || h.sessions.get(key)?.running) await new Promise(resolve => setImmediate(resolve));
    assert.equal(parentTurns, 1);
    assert.equal(h.snapshotSessions().find(s => s.key === key)!.tasks![0].state, "waiting", "even assessed completion retains the running native dependency");
    await h.tick(); assert.equal(parentTurns, 1);
    // Runtime settlement delivers through the real native child channel.
    release(); await h.drained();
    assert.equal(parentTurns, 2);
    const task = h.snapshotSessions().find(s => s.key === key)!.tasks!.find(t => t.id === "original")!;
    assert.equal(task.state, "completed");
    await children.flushResults(); await h.drained(); assert.equal(parentTurns, 2, "accepted result is not repeated");
  } finally { release(); await h.stop(0); }
});

for (const fence of ["none", "stop", "expiry", "queued-expiry", "legacy", "save-failure"] as const)
test(`native result restart/dedup fence: ${fence}`, async () => {
  let children!: Subagents, turns = 0, fail = fence === "save-failure", now = 1000;
  const runtime = new FakeRuntime((_text, sessionKey) => { if (sessionKey === key) turns++; return "Handled retained result"; });
  const h = new Harness({ runtime, now: () => now, tickMs: 600000,
    hostEventAllowed: i => !!children.resultExecution(i), nativeSubagentExecution: i => children.resultExecution(i),
    pendingNativeSubagent: (parent, id) => children.pending(parent, id),
    completionCheck: async () => ({ state: "completed" }) });
  children = new Subagents(h, async () => { if (fail) throw Error("disk unavailable"); });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {}; h.commandHandler = async () => true;
  const original = "Use the exact retained child";
  h.restoreSessions([{ key, tasks: [{ id: "owner", original, state: fence === "stop" ? "stopped" : "waiting", depth: 0,
    ...(["expiry", "queued-expiry"].includes(fence) ? { expiresAt: fence === "expiry" ? 500 : 2000 } : {}), anchor: { id: "owner", task: original, receivedAt: 1, replyTo: { channel: "mem", target: "room1" } } }] }]);
  const record: SubagentRecord = { id: "child", parent: key, parentTaskId: "owner", sessionKey: "subagent:child", handover,
    state: "failed", result: "Retained runtime failure", expiresAt: 9000, resultEvent: "pending",
    ...(fence !== "legacy" ? { dependency: { taskId: "owner", original, depth: 0, anchor: { id: "owner", task: original, receivedAt: 1 } } } : {}) };
  children.restore([record]);
  try {
    if (fence === "queued-expiry") {
      h.paused = true; await children.flushResults();
      now = 3000; h.paused = false; await h.tick(); await h.drained();
      assert.equal(turns, 0, "expired queued event never becomes an unscoped runtime turn");
    }
    if (fail) {
      await assert.rejects(children.flushResults(), /disk unavailable/);
      await h.drained(); assert.equal(turns, 1, "inbox accepted before acknowledgement failure");
      assert.equal(h.snapshotSessions().find(s => s.key === key)!.tasks![0].state, "completed", "transport acknowledgement debt is not running child work");
      // Acceptance must remain pinned even beyond the ordinary seen window.
      for (let n = 0; n < Harness.SEEN_MAX + 1; n++) await h.accept({ id: `other-${n}`, sessionKey: "mem:other", source: "channel", text: "/noop" });
      fail = false;
    }
    await children.flushResults(); await h.drained();
    assert.equal(turns, ["none", "save-failure"].includes(fence) ? 1 : 0);
    await children.flushResults(); await h.drained();
    assert.equal(children.snapshot()[0].resultEvent, "accepted");
    assert.equal(turns, ["none", "save-failure"].includes(fence) ? 1 : 0, "stable inbox ID deduplicates acknowledgement retry");
    const forged = { id: "subagent-result:child", sessionKey: "mem:other", source: "host" as const, text: "claim", hostEvent: { executionId: "child", nativeSubagent: true as const } };
    assert.equal(children.resultExecution(forged), undefined, "result never crosses parent conversations");
  } finally { await h.stop(0); }
});


test("closed native-child order delivers evidence only to the original destination", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "native-closed-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const original = "Read the retained rules", ref = await store.enrollTask(key, "owner", original, "owner", "operator");
  await store.decideTask(ref, 1, "close", "close", "This topic is done");
  let children!: Subagents, calls = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { calls++; return "Must not execute"; }), tickMs: 600000,
    executionStore: store, taskLifecycle: { enabled: true }, hostEventAllowed: i => !!children.resultExecution(i),
    nativeSubagentExecution: i => children.resultExecution(i) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {};
  children = new Subagents(h, async () => {});
  h.restoreSessions([{ key, tasks: [{ id: "owner", original, state: "waiting", depth: 0, taskRef: ref }] }]);
  children.restore([{ id: "closed-child", parent: key, parentTaskId: "owner", sessionKey: "subagent:closed-child", handover,
    state: "completed", expiresAt: Date.now() + 60000, result: "Exact late child evidence", resultEvent: "pending",
    dependency: { taskId: "owner", original, depth: 0, taskRef: ref }, origin: { channel: "mem", target: "original-room" } }]);
  try {
    await children.flushResults(); await h.drained();
    assert.equal(calls, 0); assert.equal(channel.sent.length, 1);
    assert.equal(channel.sent[0].to.target, "original-room"); assert.match(channel.sent[0].text, /Exact late child evidence/);
    assert.equal(store.coreTask(ref.id)!.operatorStatus, "done");
  } finally { await h.stop(0); }
});

test("cancellation during optional result preparation cannot be overwritten by late success", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<string>(resolve => { release = () => resolve("Late success"); });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const runtime = new FakeRuntime(); runtime.compactResult = async () => { entered(); return held; };
  const h = new Harness({ runtime, tickMs: 600000 }); h.onStateChange = async () => {};
  const children = new Subagents(h, async () => {});
  children.restore([{ id: "race", parent: key, parentTaskId: "owner", sessionKey: "subagent:race", handover,
    state: "running", expiresAt: Date.now() + 60000, dependency: { taskId: "owner", original: "Read", depth: 0 } }]);
  try {
    const sending = children.channel.send({ channel: "subagents", target: "race" }, "Late success");
    await started; await children.cancel(key, "race"); release(); await sending;
    assert.equal(children.get(key, "race").state, "cancelled");
    assert.match(children.get(key, "race").result!, /Cancellation requested/);
  } finally { release(); await h.stop(0); }
});


test("child admission failure retains conservative durable result for restart delivery", async () => {
  let children!: Subagents, turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "Failure handled"; }), tickMs: 600000,
    hostEventAllowed: i => !!children.resultExecution(i), nativeSubagentExecution: i => children.resultExecution(i) });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  children = new Subagents(h, async () => {});
  const original = "Read child rules";
  h.restoreSessions([{ key, tasks: [{ id: "owner", original, state: "waiting", depth: 0 }] }]);
  h.sessions.get(key)!.current = { id: "owner", taskId: "owner", source: "api", sessionKey: key, text: original };
  const accept = h.accept.bind(h);
  h.accept = async () => { throw Error("inbox save unavailable"); };
  try {
    await assert.rejects(children.start(key, handover), /inbox save unavailable/);
    const retained = children.snapshot()[0];
    assert.equal(retained.state, "failed"); assert.equal(retained.resultEvent, "pending");
    assert.match(retained.result!, /external effects require reconciliation/);
    h.sessions.get(key)!.current = undefined; h.accept = accept;
    children.restore(JSON.parse(JSON.stringify(children.snapshot())));
    await children.reconcile(); await h.drained();
    assert.equal(turns, 1); assert.equal(children.snapshot()[0].resultEvent, "accepted");
  } finally { await h.stop(0); }
});
