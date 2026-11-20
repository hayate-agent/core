import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RunRegistry } from "../src/api/runs.js";
import { ApiChannel } from "../src/api/server.js";
import { ExecutionStore } from "../src/execution.js";
import { DEFAULT_API_RESULT_HOLD_MS, Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

const KEY = ["test", "api", "key"].join("-");
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

// Paperclip (hermes_gateway) authorizes agent writes only with the run id of a
// heartbeat run that is still running. A run that ends when Main posts an interim
// answer strands its delegated worker: it can no longer write its result.
async function setup(t: import("node:test").TestContext, extra: Partial<ConstructorParameters<typeof Harness>[0]> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-"));
  let now = 1_000_000;
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const runtime = new FakeRuntime(text => text.startsWith("Dispatcher result") ? "Final: SHR-1 updated with the worker result." : "Interim: worker dispatched.");
  const harness = new Harness({ runtime, executionStore: store, tickMs: 600_000, busyMode: "queue", log: () => {}, now: () => now, hostEventAllowed: () => true, ...extra });
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id),
    models: async () => ["gw/model-a"], defaultModel: () => "gw/model-a", log: () => {} });
  harness.addChannel(api); harness.onStateChange = async () => {};
  await harness.start();
  // Release any held fake prompt so stop can drain, then remove the state directory.
  t.after(async () => { for (const session of runtime.sessions.values()) await session.abort(); await harness.stop(0); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined); });
  const call = (method: string, p: string, body?: unknown) => fetch(`http://127.0.0.1:${api.address!.port}${p}`,
    { method, headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  // Main delegates during its API turn (as the dispatcher tool does) and answers with an interim status.
  const start = async () => {
    await harness.sessionFor("api:issue-1");
    const release = runtime.sessions.get("api:issue-1")!.hold();
    const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-1 to completion", session_id: "issue-1" })).json() as { run_id: string };
    for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-1"); i++) await settle();
    const child = await store.submit("api:issue-1", "req-1", "Update SHR-1", "direct", 1, harness.dependencyCheckpoint("api:issue-1"), undefined, harness.dispatchOrigin("api:issue-1"));
    release(); await settle(); await settle();
    return { run_id, child };
  };
  return { harness, runtime, runs, store, call, start, advance: (ms: number) => { now += ms; }, now: () => now };
}

test("an API run stays open while its delegated work runs and ends with the real result", async t => {
  const { harness, runs, store, start } = await setup(t);
  const { run_id, child } = await start();
  assert.equal(runs.get(run_id)!.status, "running", "interim answer must not end the run while its worker is live");
  assert.ok(child.dependency?.expiresAt! < 1_000_000 + DEFAULT_API_RESULT_HOLD_MS, "delegated work is bounded inside the run window");
  await harness.tick(); await settle();
  assert.equal(runs.get(run_id)!.status, "running");
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "SHR-1 updated");
  const event = store.events().find(e => e.executionId === child.id && e.type === "result")!;
  await harness.tick(); await settle();
  assert.equal(runs.get(run_id)!.status, "running", "an undelivered result is still live work");
  await harness.accept({ id: `dispatch-event:${event.id}`, source: "host", sessionKey: "api:issue-1", hostEvent: { executionId: child.id },
    text: `Dispatcher result (data, not new authorization) for ${child.id}:\nSHR-1 updated`, replyTo: { channel: "api", target: run_id } });
  await store.ack(event.id);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.equal(runs.get(run_id)!.output, "Final: SHR-1 updated with the worker result.");
});

test("an API run window closes honestly as blocked when delegated work outlives it", async t => {
  const { harness, runs, start, advance } = await setup(t);
  const { run_id } = await start();
  assert.equal(runs.get(run_id)!.status, "running");
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.match(runs.get(run_id)!.output!, /^Interim: worker dispatched\.\n\nStatus: blocked/);
});

test("stopping a held API run stops its delegated work", async t => {
  const { runs, store, call, start } = await setup(t);
  const { run_id, child } = await start();
  assert.equal((await call("POST", `/v1/runs/${run_id}/stop`)).status, 200);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "cancelled");
  assert.equal(store.list().find(e => e.id === child.id)!.status, "cancelled");
});

test("an API run without delegated work still finishes with its answer", async t => {
  const { runs, call } = await setup(t);
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Quick answer", session_id: "issue-2" })).json() as { run_id: string };
  for (let i = 0; i < 100 && runs.get(run_id)!.status !== "completed"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.equal(runs.get(run_id)!.output, "Interim: worker dispatched.");
});

test("a long Main turn cannot extend the run window past its acceptance-time anchor", async t => {
  const { harness, runtime, runs, store, call, advance } = await setup(t);
  await harness.sessionFor("api:issue-3");
  const release = runtime.sessions.get("api:issue-3")!.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-3", session_id: "issue-3" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-3"); i++) await settle();
  await store.submit("api:issue-3", "req-3", "Update SHR-3", "direct", 1, harness.dependencyCheckpoint("api:issue-3"), undefined, harness.dispatchOrigin("api:issue-3"));
  advance(DEFAULT_API_RESULT_HOLD_MS - 1000); // Main's own turn consumes almost the whole window
  release(); await settle(); await settle();
  advance(2000);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed", "run ends at the acceptance-anchored deadline, not reply time + window");
  assert.match(runs.get(run_id)!.output!, /Status: blocked/);
});

test("a reply after the closed window with live work still ends blocked, not as done", async t => {
  const { harness, runtime, runs, store, call, advance } = await setup(t);
  await harness.sessionFor("api:issue-4");
  const release = runtime.sessions.get("api:issue-4")!.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-4", session_id: "issue-4" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-4"); i++) await settle();
  await store.submit("api:issue-4", "req-4", "Update SHR-4", "direct", 1, harness.dependencyCheckpoint("api:issue-4"), undefined, harness.dispatchOrigin("api:issue-4"));
  const child = store.list().find(e => e.dependency?.taskId)!;
  await store.claim(child.id); // a live, running worker
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  release(); await settle(); await settle();
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.match(runs.get(run_id)!.output!, /Status: blocked/);
  const row = store.list().find(e => e.id === child.id)!;
  assert.equal(row.status, "cancelled", "late reply must not leave the worker running detached"); assert.equal(row.parentStopped, true);
});

test("queue wait before the turn counts against the run window", async t => {
  const { harness, runtime, runs, store, call, advance } = await setup(t);
  await harness.sessionFor("api:issue-5");
  const blocker = runtime.sessions.get("api:issue-5")!.hold();
  await call("POST", "/v1/runs", { input: "Earlier run", session_id: "issue-5" });
  for (let i = 0; i < 100 && runtime.sessions.get("api:issue-5")!.prompts.length < 1; i++) await settle();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-5", session_id: "issue-5" })).json() as { run_id: string };
  advance(DEFAULT_API_RESULT_HOLD_MS - 1000); // waits in the queue behind the earlier run
  const release = runtime.sessions.get("api:issue-5")!.hold();
  blocker(); for (let i = 0; i < 100 && harness.dispatchOrigin("api:issue-5")?.target !== run_id; i++) await settle();
  const child = await store.submit("api:issue-5", "req-5", "Update SHR-5", "direct", 1, harness.dependencyCheckpoint("api:issue-5"), undefined, harness.dispatchOrigin("api:issue-5"));
  assert.ok(child.dependency!.expiresAt! < 1_000_000 + DEFAULT_API_RESULT_HOLD_MS, "work window is anchored at acceptance, before the queue wait");
  release(); await settle(); await settle();
  advance(2000);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.match(runs.get(run_id)!.output!, /Status: blocked/);
});

test("a running unrelated turn in the session does not delay a held run past its deadline", async t => {
  const { harness, runtime, runs, start, advance } = await setup(t);
  const { run_id } = await start();
  assert.equal(runs.get(run_id)!.status, "running");
  runtime.sessions.get("api:issue-1")!.hold();
  await harness.enqueue({ source: "cron", sessionKey: "api:issue-1", text: "unrelated scheduled work" }); await settle();
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.match(runs.get(run_id)!.output!, /Status: blocked/);
});

test("closing the window revokes a running worker instead of leaving it detached", async t => {
  const { harness, runs, store, start, advance } = await setup(t);
  const { run_id, child } = await start();
  await store.claim(child.id);
  assert.equal(store.list().find(e => e.id === child.id)!.status, "running");
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.match(runs.get(run_id)!.output!, /Status: blocked/);
  const row = store.list().find(e => e.id === child.id)!;
  assert.equal(row.status, "cancelled"); assert.equal(row.parentStopped, true);
});

test("stop racing the release tick ends the run cancelled, never completed", async t => {
  const { harness, runs, store, call, start } = await setup(t);
  const { run_id, child } = await start();
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "done");
  const stopping = call("POST", `/v1/runs/${run_id}/stop`);
  await harness.tick();
  assert.equal((await stopping).status, 200);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "cancelled");
});

test("a native child result awaiting inbox delivery keeps the run open", async t => {
  let resultPending = true;
  const { harness, runs, store, start } = await setup(t, { pendingNativeResult: () => resultPending });
  const { run_id, child } = await start();
  // The dispatcher child settles and is acknowledged; only the native result is outstanding.
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "done");
  for (const event of store.events()) await store.ack(event.id);
  await harness.tick(); await settle();
  assert.equal(runs.get(run_id)!.status, "running", "terminal native child with undelivered result is live work");
  resultPending = false;
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.equal(runs.get(run_id)!.output, "Interim: worker dispatched.");
});

test("an expired held run restored after a crash still revokes its worker and finishes blocked", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-restart-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("api:issue-9", "req-9", "Update SHR-9", "direct", 1, { taskId: "t9", original: "Work SHR-9", depth: 0, expiresAt: 900 });
  await store.claim(child.id);
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const record = runs.create({ session_key: "api:issue-9" }); runs.started(record.run_id); await runs.save();
  const harness = new Harness({ runtime: new FakeRuntime(), executionStore: store, tickMs: 600_000, log: () => {}, now: () => 2000 });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  harness.addChannel(api); harness.onStateChange = async () => {};
  harness.restoreSessions([{ key: "api:issue-9", tasks: [{ id: "t9", original: "Work SHR-9", state: "blocked", termination: "deadline_expired", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 1000, apiHold: { deadline: 1000, entry: { id: "held-9", sessionKey: "api:issue-9", to: { channel: "api", target: record.run_id }, text: "Interim" } } }] }]);
  assert.deepEqual(harness.heldApiRuns(), [record.run_id], "startup reconciliation keeps the held run alive");
  await harness.start(); t.after(() => harness.stop(0));
  await harness.tick(); for (let i = 0; i < 100 && runs.get(record.run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(record.run_id)!.status, "completed");
  assert.match(runs.get(record.run_id)!.output!, /Status: blocked/);
  assert.equal(store.list()[0].status, "cancelled");
});

test("a held-run stop keeps the run open until child revocation is durable, also across a crash", async t => {
  const { harness, runs, store, call, start } = await setup(t);
  const { run_id, child } = await start();
  await store.claim(child.id);
  const checkpoints: string[] = [];
  harness.onStateChange = async () => { checkpoints.push(JSON.stringify(harness.outboxEntries())); };
  assert.equal((await call("POST", `/v1/runs/${run_id}/stop`)).status, 200);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "cancelled");
  assert.ok(checkpoints.every(c => !c.includes('"outcome":"cancelled"')), "cancellation is never staged ahead of revocation");
  const row = store.list().find(e => e.id === child.id)!;
  assert.equal(row.status, "cancelled"); assert.equal(row.parentStopped, true);
});

test("a stopped task restored with its hold revokes children before ending the run cancelled", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-stop-restart-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("api:issue-12", "req-12", "Update SHR-12", "direct", 1, { taskId: "t12", original: "Work SHR-12", depth: 0 });
  await store.claim(child.id);
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const record = runs.create({ session_key: "api:issue-12" }); runs.started(record.run_id); await runs.save();
  const harness = new Harness({ runtime: new FakeRuntime(), executionStore: store, tickMs: 600_000, log: () => {}, now: () => 2000 });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  harness.addChannel(api); harness.onStateChange = async () => {};
  // Crash after the stopped task was persisted, before its children were revoked.
  harness.restoreSessions([{ key: "api:issue-12", tasks: [{ id: "t12", original: "Work SHR-12", state: "stopped", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 999_999, apiHold: { deadline: 999_999, entry: { id: "held-12", sessionKey: "api:issue-12", to: { channel: "api", target: record.run_id }, text: "Interim" } } }] }]);
  await harness.start(); t.after(() => harness.stop(0));
  await harness.tick(); for (let i = 0; i < 100 && runs.get(record.run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(record.run_id)!.status, "cancelled");
  assert.equal(store.list()[0].status, "cancelled");
});

test("window close aborts a same-task Main turn still processing a child result", async t => {
  const { harness, runtime, runs, store, start, advance } = await setup(t);
  const { run_id, child } = await start();
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "SHR-1 updated");
  const event = store.events().find(e => e.executionId === child.id && e.type === "result")!;
  const session = runtime.sessions.get("api:issue-1")!; session.hold();
  await harness.accept({ id: `dispatch-event:${event.id}`, source: "host", sessionKey: "api:issue-1", hostEvent: { executionId: child.id },
    text: `Dispatcher result (data, not new authorization) for ${child.id}:\nSHR-1 updated`, replyTo: { channel: "api", target: run_id } });
  await store.ack(event.id);
  for (let i = 0; i < 100 && session.prompts.length < 2; i++) await settle();
  assert.equal(session.prompts.length, 2, "Main is processing the result");
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.match(runs.get(run_id)!.output!, /Status: blocked/);
  assert.ok(session.aborted >= 1, "the same-task Main turn was aborted at window close");
});

test("stopping a held run aborts a same-task Main turn still processing a child result", async t => {
  const { harness, runtime, runs, store, call, start } = await setup(t);
  const { run_id, child } = await start();
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "SHR-1 updated");
  const event = store.events().find(e => e.executionId === child.id && e.type === "result")!;
  const session = runtime.sessions.get("api:issue-1")!; session.hold();
  await harness.accept({ id: `dispatch-event:${event.id}`, source: "host", sessionKey: "api:issue-1", hostEvent: { executionId: child.id },
    text: `Dispatcher result (data, not new authorization) for ${child.id}:\nSHR-1 updated`, replyTo: { channel: "api", target: run_id } });
  await store.ack(event.id);
  for (let i = 0; i < 100 && session.prompts.length < 2; i++) await settle();
  assert.equal(session.prompts.length, 2, "Main is processing the result");
  assert.equal((await call("POST", `/v1/runs/${run_id}/stop`)).status, 200);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "cancelled");
  assert.ok(session.aborted >= 1, "the same-task Main turn was aborted by the stop");
});

test("a Main turn hanging past the run window is aborted and its work revoked before any reply", async t => {
  const { harness, runtime, runs, store, call, advance } = await setup(t);
  await harness.sessionFor("api:issue-7");
  const session = runtime.sessions.get("api:issue-7")!; session.hold(); // never replies on its own
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-7", session_id: "issue-7" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-7"); i++) await settle();
  const child = await store.submit("api:issue-7", "req-7", "Update SHR-7", "direct", 1, harness.dependencyCheckpoint("api:issue-7"), undefined, harness.dispatchOrigin("api:issue-7"));
  await store.claim(child.id);
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.notEqual(runs.get(run_id)!.status, "running", "run ends at its window, not when Main eventually replies");
  assert.ok(session.aborted >= 1);
  assert.equal(store.list().find(e => e.id === child.id)!.status, "cancelled");
});

test("a run queued past its window behind a long turn ends without ever starting", async t => {
  const { harness, runtime, runs, call, advance } = await setup(t);
  await harness.sessionFor("api:issue-8");
  const session = runtime.sessions.get("api:issue-8")!; session.hold(); // a long-running earlier turn
  await call("POST", "/v1/runs", { input: "Earlier long run", session_id: "issue-8" });
  for (let i = 0; i < 100 && session.prompts.length < 1; i++) await settle();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-8", session_id: "issue-8" })).json() as { run_id: string };
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "queued"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "cancelled");
  assert.equal(session.prompts.filter(p => p.includes("SHR-8")).length, 0, "expired run never reached the model");
});

test("a held answer is part of the durable turn settlement", async t => {
  const { store, start } = await setup(t);
  const settled: Array<{ to: { target: string }; apiHeldUntil?: number }> = [];
  const original = store.settleTurn.bind(store);
  store.settleTurn = (async (id: string, key: string, settlement: { outbox: typeof settled }) => {
    settled.push(...structuredClone(settlement.outbox)); return original(id, key, settlement as never);
  }) as typeof store.settleTurn;
  const { run_id } = await start();
  const held = settled.find(entry => entry.to.target === run_id);
  assert.ok(held?.apiHeldUntil, "settlement records the held answer with its deadline (crash-replay restores the hold)");
});

test("graceful shutdown keeps a held run open (persisted) instead of finishing it with live work", async t => {
  const { harness, runtime, runs, store, call } = await setup(t);
  await harness.sessionFor("api:issue-10");
  const release = runtime.sessions.get("api:issue-10")!.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-10", session_id: "issue-10" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-10"); i++) await settle();
  const child = await store.submit("api:issue-10", "req-10", "Update SHR-10", "direct", 1, harness.dependencyCheckpoint("api:issue-10"), undefined, harness.dispatchOrigin("api:issue-10"));
  await store.claim(child.id);
  const stopping = harness.stop(5000); release(); await stopping;
  assert.equal(runs.get(run_id)!.status, "running", "drain must not finish the run while its worker is live");
  assert.deepEqual(harness.heldApiRuns(), [run_id], "the held answer is retained for the restarted host");
});

test("a failed Main turn revokes its live worker before the run ends failed", async t => {
  const { harness, runtime, runs, store, call } = await setup(t);
  await harness.sessionFor("api:issue-11");
  const release = runtime.sessions.get("api:issue-11")!.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-11", session_id: "issue-11" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-11"); i++) await settle();
  const child = await store.submit("api:issue-11", "req-11", "Update SHR-11", "direct", 1, harness.dependencyCheckpoint("api:issue-11"), undefined, harness.dispatchOrigin("api:issue-11"));
  await store.claim(child.id);
  runtime.answer = () => { throw Error("model failed"); };
  release(); await settle(); await settle();
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "failed");
  const row = store.list().find(e => e.id === child.id)!;
  assert.equal(row.status, "cancelled", "a failed run must not leave its worker running"); assert.equal(row.parentStopped, true);
});

test("window expiry revokes children before the aborted turn can end the run", async t => {
  const { harness, runtime, runs, store, call, advance } = await setup(t);
  await harness.sessionFor("api:issue-13");
  const session = runtime.sessions.get("api:issue-13")!; session.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-13", session_id: "issue-13" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-13"); i++) await settle();
  const child = await store.submit("api:issue-13", "req-13", "Update SHR-13", "direct", 1, harness.dependencyCheckpoint("api:issue-13"), undefined, harness.dispatchOrigin("api:issue-13"));
  await store.claim(child.id);
  let childAtAbort: string | undefined;
  const abort = session.abort.bind(session);
  session.abort = async () => { childAtAbort ??= store.list().find(e => e.id === child.id)!.status; return abort(); };
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(childAtAbort, "cancelled", "worker revoked before the turn abort could end the run");
});

test("stop during a same-task turn marks the task stopped before the turn abort, so a tick cannot complete it", async t => {
  const { harness, runtime, runs, store, call, start } = await setup(t);
  const { run_id, child } = await start();
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "SHR-1 updated");
  const event = store.events().find(e => e.executionId === child.id && e.type === "result")!;
  const session = runtime.sessions.get("api:issue-1")!; session.hold();
  await harness.accept({ id: `dispatch-event:${event.id}`, source: "host", sessionKey: "api:issue-1", hostEvent: { executionId: child.id },
    text: `Dispatcher result (data, not new authorization) for ${child.id}:\nSHR-1 updated`, replyTo: { channel: "api", target: run_id } });
  await store.ack(event.id);
  for (let i = 0; i < 100 && session.prompts.length < 2; i++) await settle();
  const abort = session.abort.bind(session);
  session.abort = async () => { await harness.tick(); return abort(); }; // deadline/settle tick races the abort
  assert.equal((await call("POST", `/v1/runs/${run_id}/stop`)).status, 200);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "cancelled");
});

test("native-only: a stopped held run revokes native children before ending cancelled", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-native-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined));
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const record = runs.create({ session_key: "api:issue-14" }); runs.started(record.run_id); await runs.save();
  const order: string[] = [];
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 600_000, log: () => {}, now: () => 2000,
    pendingNativeSubagent: () => true, taskStopped: async () => { order.push("native-revoked"); } });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  const send = api.send.bind(api);
  api.send = async (to, text, meta) => { if (!meta?.presentation) order.push(`run:${meta?.outcome ?? "completed"}`); return send(to, text, meta); };
  harness.addChannel(api); harness.onStateChange = async () => {};
  harness.restoreSessions([{ key: "api:issue-14", tasks: [{ id: "t14", original: "Work SHR-14", state: "stopped", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 999_999, apiHold: { deadline: 999_999, entry: { id: "held-14", sessionKey: "api:issue-14", to: { channel: "api", target: record.run_id }, text: "Interim" } } }] }]);
  await harness.start(); t.after(() => harness.stop(0));
  await harness.tick(); for (let i = 0; i < 100 && runs.get(record.run_id)!.status === "running"; i++) await settle();
  assert.equal(runs.get(record.run_id)!.status, "cancelled");
  assert.deepEqual(order, ["native-revoked", "run:cancelled"]);
});

test("a child question not yet in Main's inbox keeps the run open", async t => {
  const { harness, runs, store, start } = await setup(t);
  const { run_id, child } = await start();
  const claim = await store.claim(child.id);
  await store.ask(child.id, claim.token!, "Which project board should SHR-1 move to?");
  assert.ok(store.events().some(e => e.executionId === child.id && e.type === "question"), "question event pending delivery");
  await harness.tick(); await settle();
  assert.equal(runs.get(run_id)!.status, "running", "an unanswered child question is live work of this run");
});

test("a native result accepted into Main's inbox but not yet processed keeps the run open", async t => {
  let taskOf: string | undefined;
  const { harness, runtime, runs, store, start } = await setup(t, { nativeResultTask: (_key, id) => id === "native-1" ? taskOf : undefined });
  const { run_id, child } = await start();
  taskOf = child.dependency!.taskId;
  // The dispatcher child is finished and its result consumed: only the native result remains open.
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "done");
  for (const e of store.events().filter(e => e.executionId === child.id)) await store.ack(e.id);
  const session = runtime.sessions.get("api:issue-1")!; session.hold(); // Main busy: the result waits in the queue
  await harness.accept({ id: "busy", source: "api", sessionKey: "api:issue-1", text: "unrelated" });
  await harness.accept({ id: "subagent-result:native-1", source: "host", sessionKey: "api:issue-1", hostEvent: { executionId: "native-1", nativeSubagent: true }, text: "Native subagent native-1 completed" });
  await harness.tick(); await settle();
  assert.equal(runs.get(run_id)!.status, "running", "an accepted, unprocessed native result is live work of the run");
});

test("a restored stale hold is not released while an input for the same run is still pending replay", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-replay-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined));
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const record = runs.create({ session_key: "api:issue-15" }); runs.started(record.run_id); await runs.save();
  const runtime = new FakeRuntime(() => "Final: SHR-15 done.");
  let now = 2000;
  const harness = new Harness({ runtime, tickMs: 600_000, log: () => {}, now: () => now });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  harness.addChannel(api); harness.onStateChange = async () => {};
  const finished: string[] = []; const send = api.send.bind(api);
  api.send = async (to, text, meta) => { if (!meta?.presentation) finished.push(text); return send(to, text, meta); };
  // Crash after the follow-up cleared the hold in memory but before it settled: checkpoint has the
  // old interim hold plus the still-pending follow-up (task id not yet bound).
  harness.restoreSessions([{ key: "api:issue-15",
    tasks: [{ id: "t15", original: "Work SHR-15", state: "active", depth: 0, recoveryEnrollment: "current",
      apiRunDeadline: 999_999, apiHold: { deadline: 999_999, entry: { id: "held-15", sessionKey: "api:issue-15", to: { channel: "api", target: record.run_id }, text: "Interim: worker dispatched." } } }] }]);
  const session = await harness.sessionFor("api:issue-15"); const release = runtime.sessions.get("api:issue-15")!.hold();
  harness.restorePending([{ id: "busy-15", source: "api", sessionKey: "api:issue-15", text: "unrelated" },
    { id: "follow-15", source: "host", sessionKey: "api:issue-15", text: "Dispatcher result: SHR-15 done", replyTo: { channel: "api", target: record.run_id } }]);
  await harness.start(); t.after(() => harness.stop(0));
  await harness.tick(); await settle();
  assert.ok(!finished.includes("Interim: worker dispatched."), "stale interim answer must not end the run while its follow-up is pending");
  // Window expiry while the unbound follow-up still waits behind the busy turn: it is dropped with the run.
  now = 1_000_000;
  await harness.tick(); for (let i = 0; i < 100 && runs.get(record.run_id)!.status === "running"; i++) await settle();
  assert.notEqual(runs.get(record.run_id)!.status, "running");
  assert.ok(!harness.pendingInputs().some(input => input.id === "follow-15"), "expired run's unbound follow-up never runs later");
  void session; release();
});

test("a reply arriving while window-close revocation is in flight is held until workers are stopped", async t => {
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  const order: string[] = [];
  const { harness, runtime, runs, store, call, advance } = await setup(t, { taskStopped: async () => { order.push("ledger-cancelled"); await gate; order.push("worker-aborted"); } });
  await harness.sessionFor("api:issue-16");
  const session = runtime.sessions.get("api:issue-16")!; const release = session.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-16", session_id: "issue-16" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-16"); i++) await settle();
  const child = await store.submit("api:issue-16", "req-16", "Update SHR-16", "direct", 1, harness.dependencyCheckpoint("api:issue-16"), undefined, harness.dispatchOrigin("api:issue-16"));
  await store.claim(child.id);
  session.abort = async () => {}; // the turn ignores abort and replies during revocation
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 50 && !order.includes("ledger-cancelled"); i++) await settle();
  release(); for (let i = 0; i < 20; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "running", "no terminal delivery while the worker is not yet aborted");
  unblock(); await settle(); await harness.tick(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await settle(); await harness.tick(); }
  assert.notEqual(runs.get(run_id)!.status, "running");
  assert.deepEqual(order, ["ledger-cancelled", "worker-aborted"]);
});

test("a failed window-close revocation keeps the run fenced and is retried before the run ends", async t => {
  let failures = 1; const order: string[] = [];
  const { harness, runs, store, start, advance } = await setup(t, { taskStopped: async () => {
    if (failures-- > 0) { order.push("abort-failed"); throw Error("worker abort failed"); } order.push("worker-aborted"); } });
  const { run_id, child } = await start();
  await store.claim(child.id);
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual(order, ["abort-failed"]);
  assert.equal(runs.get(run_id)!.status, "running", "ledger cancelled but worker not aborted: the run stays fenced");
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.deepEqual(order, ["abort-failed", "worker-aborted"]);
  assert.notEqual(runs.get(run_id)!.status, "running");
});

test("a cancelled turn result during pending revocation stays fenced until the worker is stopped", async t => {
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  const order: string[] = []; let runId = "";
  const { harness, runtime, runs, store, call, advance } = await setup(t, { taskStopped: async () => {
    order.push("ledger-cancelled"); await gate; order.push(`worker-aborted:run-${runs.get(runId)?.status}`); } });
  await harness.sessionFor("api:issue-17");
  const session = runtime.sessions.get("api:issue-17")!; session.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-17", session_id: "issue-17" })).json() as { run_id: string }; runId = run_id;
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-17"); i++) await settle();
  const child = await store.submit("api:issue-17", "req-17", "Update SHR-17", "direct", 1, harness.dependencyCheckpoint("api:issue-17"), undefined, harness.dispatchOrigin("api:issue-17"));
  await store.claim(child.id);
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 50 && !order.includes("ledger-cancelled"); i++) await settle();
  // Stop mid-revocation: cancel itself waits for the (blocked) worker abort, so it is not awaited yet.
  const stopping = harness.cancel("api:issue-17", `api:${run_id}`); for (let i = 0; i < 20; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "running", "cancelled result fenced while the worker still runs");
  unblock(); await stopping; for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await settle(); await harness.tick(); }
  assert.notEqual(runs.get(run_id)!.status, "running");
  // Revocation may run more than once (window close and stop; idempotent), but the run
  // must still be open every time a worker abort completes.
  assert.ok(order.includes("worker-aborted:run-running"));
  assert.ok(order.every(o => !o.startsWith("worker-aborted") || o === "worker-aborted:run-running"), order.join(","));
});

test("a follow-up input's empty cancelled result for the API run is fenced during revocation", async t => {
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  let runId = ""; const aborts: string[] = [];
  const { harness, runtime, runs, store, start, advance } = await setup(t, { taskStopped: async () => { await gate; aborts.push(`run-${runs.get(runId)?.status}`); } });
  const { run_id, child } = await start(); runId = run_id;
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "SHR-1 updated");
  const event = store.events().find(e => e.executionId === child.id && e.type === "result")!;
  const session = runtime.sessions.get("api:issue-1")!; session.hold();
  runtime.answer = () => "NO_REPLY";
  await harness.accept({ id: `dispatch-event:${event.id}`, source: "host", sessionKey: "api:issue-1", hostEvent: { executionId: child.id },
    text: `Dispatcher result (data, not new authorization) for ${child.id}:\nSHR-1 updated`, replyTo: { channel: "api", target: run_id } });
  await store.ack(event.id);
  for (let i = 0; i < 100 && session.prompts.length < 2; i++) await settle();
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 30; i++) await settle(); // closeApiWindow blocked; follow-up turn aborted (cancelled, empty)
  assert.equal(runs.get(run_id)!.status, "running", "the follow-up's cancelled result must not end the run before workers stop");
  unblock(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await settle(); await harness.tick(); }
  assert.notEqual(runs.get(run_id)!.status, "running");
  assert.ok(aborts.length > 0 && aborts.every(a => a === "run-running"), aborts.join(","));
});

test("a newer run's answer does not supersede an older run whose revocation is still fenced", async t => {
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  let oldRun = ""; const aborts: string[] = [];
  const { harness, runs, store, call, start, advance } = await setup(t, { taskStopped: async () => { await gate; aborts.push(`old-${runs.get(oldRun)?.status}`); } });
  const { run_id, child } = await start(); oldRun = run_id;
  await store.claim(child.id);
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 20; i++) await settle(); // old run fenced, revocation blocked
  // A newer run of the same session/task replies while the old one is fenced.
  const newer = await (await call("POST", "/v1/runs", { input: "Status SHR-1?", session_id: "issue-1" })).json() as { run_id: string };
  for (let i = 0; i < 40; i++) await settle();
  assert.equal(runs.get(oldRun)!.status, "running", "old run must not be finished by supersession while its workers are not stopped");
  unblock(); for (let i = 0; i < 100 && (runs.get(oldRun)!.status === "running" || runs.get(newer.run_id)!.status === "running" || runs.get(newer.run_id)!.status === "queued"); i++) { await settle(); await harness.tick(); }
  assert.notEqual(runs.get(oldRun)!.status, "running");
  assert.ok(aborts.length > 0 && aborts.every(a => a === "old-running"), aborts.join(","));
});

test("a pending revocation fence survives restart: workers are revoked before the restored run ends", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-fence-restart-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined));
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const record = runs.create({ session_key: "api:issue-18" }); runs.started(record.run_id);
  const deferred = runs.create({ session_key: "api:issue-18" }); runs.started(deferred.run_id); await runs.save();
  const order: string[] = [];
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 600_000, log: () => {}, now: () => 2000,
    pendingNativeSubagent: () => false, taskStopped: async () => { order.push("worker-aborted"); } });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  const send = api.send.bind(api);
  api.send = async (to, text, meta) => { if (!meta?.presentation) order.push(`run-end:${to.target === record.run_id ? "old" : "new"}`); return send(to, text, meta); };
  harness.addChannel(api); harness.onStateChange = async () => {};
  // Crash after the ledger was cancelled but before the physical worker abort succeeded.
  harness.restoreSessions([{ key: "api:issue-18", tasks: [{ id: "t18", original: "Work SHR-18", state: "blocked", termination: "deadline_expired", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 1000, apiRevoking: true,
    apiHold: { deadline: 1000, entry: { id: "held-18", sessionKey: "api:issue-18", to: { channel: "api", target: record.run_id }, text: "Interim" } },
    apiDeferred: [{ id: "new-18", sessionKey: "api:issue-18", to: { channel: "api", target: deferred.run_id }, text: "Newer answer" }] }] }]);
  assert.deepEqual(harness.heldApiRuns().sort(), [record.run_id, deferred.run_id].sort(), "deferred runs survive startup reconciliation");
  await harness.start(); t.after(() => harness.stop(0));
  for (let i = 0; i < 100 && (runs.get(record.run_id)!.status === "running" || runs.get(deferred.run_id)!.status === "running"); i++) { await harness.tick(); await settle(); }
  assert.equal(order[0], "worker-aborted", order.join(","));
  assert.ok(order.indexOf("run-end:old") > 0 && order.indexOf("run-end:new") > order.indexOf("run-end:old"), order.join(","));
});

test("a restored revocation fence without a held answer is retried on the tick", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-fence-nohold-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined));
  const order: string[] = [];
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 600_000, log: () => {}, now: () => 2000,
    pendingNativeSubagent: () => false, taskStopped: async () => { order.push("worker-aborted"); } });
  harness.onStateChange = async () => {};
  harness.restoreSessions([{ key: "api:issue-19", tasks: [{ id: "t19", original: "Work SHR-19", state: "active", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 1000, apiRevoking: true }] }]);
  await harness.start(); t.after(() => harness.stop(0));
  for (let i = 0; i < 50 && !order.length; i++) { await harness.tick(); await settle(); }
  assert.deepEqual(order, ["worker-aborted"]);
});

test("a failed fence save is retried before any revocation step", async t => {
  let saves = 0; const order: string[] = [];
  const { harness, runs, store, start, advance } = await setup(t, { taskStopped: async () => { order.push("worker-aborted"); } });
  const { run_id, child } = await start();
  await store.claim(child.id);
  harness.onStateChange = async () => { saves++; if (saves === 1) { order.push("save-failed"); throw Error("disk full"); } order.push("saved"); };
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.equal(order[0], "save-failed");
  assert.ok(order.indexOf("saved") >= 0 && order.indexOf("saved") < order.indexOf("worker-aborted"), order.join(","));
  assert.equal(store.list().find(e => e.id === child.id)!.status, "cancelled");
});

test("a fenced run without any held answer stays alive in startup reconciliation", async () => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 600_000, log: () => {}, pendingNativeSubagent: () => false });
  harness.restoreSessions([{ key: "api:issue-20", tasks: [{ id: "t20", original: "Work SHR-20", state: "active", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 1000, apiRevoking: true, apiRevokingRun: "run_fenced20" }] }]);
  assert.deepEqual(harness.heldApiRuns(), ["run_fenced20"]);
});

test("a deferred newer answer is re-held and released through its own work check, never pushed directly", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-deferred-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined));
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const old = runs.create({ session_key: "api:issue-21" }); runs.started(old.run_id);
  const newer = runs.create({ session_key: "api:issue-21" }); runs.started(newer.run_id); await runs.save();
  let nativeLive = false;
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 600_000, log: () => {}, now: () => 2000, pendingNativeSubagent: () => nativeLive });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  harness.addChannel(api); harness.onStateChange = async () => {};
  harness.restoreSessions([{ key: "api:issue-21", tasks: [{ id: "t21", original: "Work SHR-21", state: "active", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 999_999,
    apiHold: { deadline: 999_999, entry: { id: "held-21", sessionKey: "api:issue-21", to: { channel: "api", target: old.run_id }, text: "Old answer" } },
    apiDeferred: [{ id: "new-21", sessionKey: "api:issue-21", to: { channel: "api", target: newer.run_id }, text: "Newer answer" }] }] }]);
  await harness.start(); t.after(() => harness.stop(0));
  for (let i = 0; i < 50 && runs.get(old.run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.equal(runs.get(old.run_id)!.status, "completed");
  nativeLive = true; // the newer run's own delegated work is live
  for (let i = 0; i < 10; i++) { await harness.tick(); await settle(); }
  assert.equal(runs.get(newer.run_id)!.status, "running", "deferred answer waits for its own live work");
  nativeLive = false;
  for (let i = 0; i < 50 && runs.get(newer.run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.equal(runs.get(newer.run_id)!.status, "completed");
});

test("while fenced, a newer run's answer cannot take over the fenced run (no hold yet), also across restart", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-fenced-identity-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined));
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const fenced = runs.create({ session_key: "api:issue-22" }); runs.started(fenced.run_id);
  const newer = runs.create({ session_key: "api:issue-22" }); runs.started(newer.run_id); await runs.save();
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  const ends: string[] = [];
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 600_000, log: () => {}, now: () => 2000, pendingNativeSubagent: () => false,
    taskStopped: async () => { await gate; ends.push("worker-aborted"); } });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  const send = api.send.bind(api);
  api.send = async (to, text, meta) => { if (!meta?.presentation) ends.push(to.target === fenced.run_id ? "fenced-end" : "newer-end"); return send(to, text, meta); };
  harness.addChannel(api); harness.onStateChange = async () => {};
  // Restored: fence pending for the original run, no answer held yet.
  harness.restoreSessions([{ key: "api:issue-22", tasks: [{ id: "t22", original: "Work SHR-22", state: "active", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 1000, apiRevoking: true, apiRevokingRun: fenced.run_id }] }]);
  await harness.start(); t.after(() => harness.stop(0));
  await harness.tick(); await settle(); // revocation in flight (blocked)
  // A newer run's answer arrives first, then the fenced run's own answer.
  assert.equal((harness as unknown as { holdApiResult: Function }).holdApiResult(harness["state"]("api:issue-22"), { id: "n", source: "api", sessionKey: "api:issue-22", taskId: "t22" },
    { id: "newer-22", sessionKey: "api:issue-22", to: { channel: "api", target: newer.run_id }, text: "Newer" }), true);
  assert.deepEqual(harness.heldApiRuns().sort(), [fenced.run_id, newer.run_id].sort(), "fenced identity kept, newer deferred");
  unblock();
  for (let i = 0; i < 100 && runs.get(newer.run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.equal(ends[0], "worker-aborted", ends.join(","));
  assert.ok(!ends.includes("fenced-end") || ends.indexOf("fenced-end") > 0, ends.join(","));
  assert.equal(ends.at(-1), "newer-end", ends.join(","));
});

test("a fenced cancelled held result stays held through settlement and replay until revocation succeeded", async t => {
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  let runId = ""; const aborts: string[] = [];
  const settled: Array<{ outcome?: string; apiHeldUntil?: number; to: { target: string } }> = [];
  const { harness, runtime, runs, store, call, advance } = await setup(t, { taskStopped: async () => { await gate; aborts.push(`run-${runs.get(runId)?.status}`); } });
  const original = store.settleTurn.bind(store);
  store.settleTurn = (async (id: string, key: string, settlement: { outbox: typeof settled }) => {
    settled.push(...structuredClone(settlement.outbox)); return original(id, key, settlement as never); }) as typeof store.settleTurn;
  await harness.sessionFor("api:issue-23");
  const session = runtime.sessions.get("api:issue-23")!; const release = session.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-23", session_id: "issue-23" })).json() as { run_id: string }; runId = run_id;
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-23"); i++) await settle();
  const child = await store.submit("api:issue-23", "req-23", "Update SHR-23", "direct", 1, harness.dependencyCheckpoint("api:issue-23"), undefined, harness.dispatchOrigin("api:issue-23"));
  await store.claim(child.id);
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 20; i++) await settle(); // fence up, revocation blocked; turn aborted → cancelled
  release(); for (let i = 0; i < 30; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "running", "cancelled result is not delivered by settlement while fenced");
  unblock(); for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await settle(); await harness.tick(); }
  assert.notEqual(runs.get(run_id)!.status, "running");
  assert.ok(aborts.length > 0 && aborts.every(a => a === "run-running"), aborts.join(","));
});

test("a deferred answer is part of the durable turn settlement", async t => {
  const { harness, start } = await setup(t);
  const { run_id } = await start();
  const s = harness["state"]("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiRevoking = true; task.apiRevokingRun = run_id; // older run fenced
  const input = { id: "follow", source: "host" as const, sessionKey: "api:issue-1", taskId: task.id };
  const entry = { id: "newer-answer", sessionKey: "api:issue-1", to: { channel: "api", target: "run_newer" }, text: "Newer" };
  assert.equal(harness["holdApiResult"](s, input, entry), true);
  const settled = harness["settledHold"](s, input) as Array<{ id: string; apiDeferredHold?: boolean }>;
  assert.deepEqual(settled.map(e => [e.id, e.apiDeferredHold]), [["newer-answer", true]], "deferred answer recorded in settlement for crash replay");
  task.apiRevoking = undefined;
});

test("stop: a same-task follow-up finishing while stop revocation is blocked stays fenced", async t => {
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  let runId = ""; const aborts: string[] = [];
  const { harness, runtime, runs, store, call, start } = await setup(t, { taskStopped: async () => { await gate; aborts.push(`run-${runs.get(runId)?.status}`); } });
  const { run_id, child } = await start(); runId = run_id;
  await store.claim(child.id);
  const session = runtime.sessions.get("api:issue-1")!; const release = session.hold();
  await harness.accept({ id: "follow-24", source: "host", sessionKey: "api:issue-1", text: "Status update", replyTo: { channel: "api", target: run_id } });
  for (let i = 0; i < 50 && session.prompts.length < 2; i++) await settle();
  const stopping = call("POST", `/v1/runs/${run_id}/stop`);
  for (let i = 0; i < 20; i++) await settle();
  release(); for (let i = 0; i < 30; i++) await settle(); // follow-up finishes while revocation is blocked
  assert.equal(runs.get(run_id)!.status, "running", "no terminal result while stop revocation is pending");
  unblock(); await stopping;
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await settle(); await harness.tick(); }
  assert.notEqual(runs.get(run_id)!.status, "running");
  assert.ok(aborts.length > 0 && aborts.every(a => a === "run-running"), aborts.join(","));
});
