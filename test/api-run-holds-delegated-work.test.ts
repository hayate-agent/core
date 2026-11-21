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
    pendingNativeSubagent: () => !order.includes("native-revoked"), taskStopped: async () => { if (!order.includes("native-revoked")) order.push("native-revoked"); } });
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

test("stop of an active API turn: a reply racing blocked worker revocation stays fenced", async t => {
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  let runId = ""; const aborts: string[] = [];
  const { harness, runtime, runs, store, call } = await setup(t, { taskStopped: async () => { await gate; aborts.push(`run-${runs.get(runId)?.status}`); } });
  await harness.sessionFor("api:issue-25");
  const session = runtime.sessions.get("api:issue-25")!; const release = session.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-25", session_id: "issue-25" })).json() as { run_id: string }; runId = run_id;
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-25"); i++) await settle();
  const child = await store.submit("api:issue-25", "req-25", "Update SHR-25", "direct", 1, harness.dependencyCheckpoint("api:issue-25"), undefined, harness.dispatchOrigin("api:issue-25"));
  await store.claim(child.id);
  session.abort = async () => {}; // the turn replies anyway
  const stopping = call("POST", `/v1/runs/${run_id}/stop`);
  for (let i = 0; i < 20; i++) await settle();
  release(); for (let i = 0; i < 30; i++) await settle();
  assert.equal(runs.get(run_id)!.status, "running", "no terminal result while stop revocation is pending");
  unblock(); await stopping;
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await settle(); await harness.tick(); }
  assert.notEqual(runs.get(run_id)!.status, "running");
  assert.ok(aborts.length > 0 && aborts.every(a => a === "run-running"), aborts.join(","));
});

test("a newer run never supersedes an older held run while its work is live", async t => {
  const { harness, runs, store, start } = await setup(t);
  const { run_id, child } = await start();
  await store.claim(child.id); // older run's worker is live
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  const input = { id: "follow", source: "host" as const, sessionKey: "api:issue-1", taskId: task.id };
  assert.equal(harness["holdApiResult"](s, input, { id: "newer", sessionKey: "api:issue-1", to: { channel: "api", target: "run_newer" }, text: "Newer" }), true);
  for (let i = 0; i < 10; i++) { await harness.tick(); await settle(); }
  assert.equal(runs.get(run_id)!.status, "running", "older run stays open while its worker is live");
  assert.equal(task.apiHold?.entry.to.target, run_id);
  assert.deepEqual(task.apiDeferred?.map((e: { id: string }) => e.id), ["newer"]);
});

test("a restored stopped hold without a fence revokes under the durable fence; a racing follow-up stays held", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-stopped-fence-")); t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined));
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const record = runs.create({ session_key: "api:issue-28" }); runs.started(record.run_id); await runs.save();
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; }); const aborts: string[] = [];
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 600_000, log: () => {}, now: () => 2000, pendingNativeSubagent: () => false,
    taskStopped: async () => { await gate; aborts.push(`run-${runs.get(record.run_id)?.status}`); } });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  harness.addChannel(api); harness.onStateChange = async () => {};
  harness.restoreSessions([{ key: "api:issue-28", tasks: [{ id: "t28", original: "Work SHR-28", state: "stopped", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 999_999, apiHold: { deadline: 999_999, entry: { id: "held-28", sessionKey: "api:issue-28", to: { channel: "api", target: record.run_id }, text: "Interim" } } }] }]);
  await harness.start(); t.after(() => harness.stop(0));
  await harness.tick(); for (let i = 0; i < 10; i++) await settle();
  const s = harness.state("api:issue-28"); const task = harness["tasks"](s)[0];
  assert.equal(task.apiRevoking, true, "stopped release revokes under the persisted fence");
  // A racing same-task terminal result is held, not delivered.
  assert.equal(harness["holdApiResult"](s, { id: "late", source: "host", sessionKey: "api:issue-28", taskId: "t28" },
    { id: "late-28", sessionKey: "api:issue-28", to: { channel: "api", target: record.run_id }, text: "late", outcome: "cancelled" }), true);
  assert.equal(runs.get(record.run_id)!.status, "running");
  unblock(); for (let i = 0; i < 100 && runs.get(record.run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.equal(runs.get(record.run_id)!.status, "cancelled");
  assert.ok(aborts.length > 0 && aborts.every(a => a === "run-running"), aborts.join(","));
});

test("a task-plan presentation for an API run is nonterminal progress", async () => {
  const { OutboxQueue } = await import("../src/delivery/outbox.js").catch(() => ({ OutboxQueue: undefined }));
  void OutboxQueue;
  const src = await (await import("node:fs/promises")).readFile(new URL("../src/execution.ts", import.meta.url), "utf8");
  assert.match(src, /task-plan`[\s\S]{0,300}presentation: "progress"/, "API task-plan view is delivered as progress");
});

test("concurrent window closes are single-flight: the fence holds until the slowest revocation finished", async t => {
  const gates: Array<() => void> = []; let calls = 0;
  const { harness, start } = await setup(t, { taskStopped: () => { calls++; return new Promise<void>(r => gates.push(r)); } });
  await start();
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  const first = harness["closeApiWindow"](s, task); const second = harness["closeApiWindow"](s, task);
  assert.equal(first, second, "a concurrent close joins the running one");
  for (let i = 0; i < 20 && !gates.length; i++) await settle();
  assert.equal(task.apiRevoking, true);
  gates.shift()!(); await first;
  assert.equal(calls, 1); assert.equal(task.apiRevoking, undefined);
});

test("stop racing a tick: one per-task revocation chain, run never ends while a revocation is pending", async t => {
  // Hold-free race: the active API turn is stopped while the tick's window close is revoking.
  const gates: Array<() => void> = []; let pendingAtEnd = -1; let runId = "";
  const { harness, runtime, runs, store, call, advance } = await setup(t, { taskStopped: () => new Promise<void>(r => gates.push(r)) });
  await harness.sessionFor("api:issue-30");
  const session = runtime.sessions.get("api:issue-30")!; const release = session.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-30", session_id: "issue-30" })).json() as { run_id: string }; runId = run_id;
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-30"); i++) await settle();
  const child = await store.submit("api:issue-30", "req-30", "Update SHR-30", "direct", 1, harness.dependencyCheckpoint("api:issue-30"), undefined, harness.dispatchOrigin("api:issue-30"));
  await store.claim(child.id);
  const finish = runs.finish.bind(runs);
  runs.finish = ((id: string, ...rest: unknown[]) => { if (id === runId && pendingAtEnd < 0) pendingAtEnd = gates.length; return (finish as Function)(id, ...rest); }) as typeof runs.finish;
  session.abort = async () => {}; // the turn replies regardless
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  await harness.tick(); for (let i = 0; i < 20 && !gates.length; i++) await settle(); // tick close in flight
  const stopping = call("POST", `/v1/runs/${run_id}/stop`);
  for (let i = 0; i < 20; i++) await settle();
  release(); // turn replies while revocations are pending
  gates.shift()!(); for (let i = 0; i < 30; i++) { await settle(); await harness.tick(); }
  for (let i = 0; i < 200 && runs.get(run_id)!.status === "running"; i++) { gates.shift()?.(); await settle(); await harness.tick(); }
  await stopping;
  assert.notEqual(runs.get(run_id)!.status, "running");
  assert.equal(pendingAtEnd, 0, "the run ended only after every revocation call completed");
});

test("the release path never delivers while a chained revocation is pending", async t => {
  const { harness, runs, start, advance, store } = await setup(t);
  const { run_id, child } = await start();
  await store.claim(child.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  let unblock!: () => void; const gate = new Promise<void>(r => { unblock = r; });
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  const tick = harness.tick(); // starts the window close
  const revoke = harness["revokeCancelledTask"].bind(harness);
  harness["revokeCancelledTask"] = async (...a: unknown[]) => { await gate; return revoke(...a); };
  const chained = harness["closeApiWindow"](s, task, { id: "stop-chain", source: "api", sessionKey: "api:issue-1", text: "", taskId: task.id }); // a stop chains another revocation
  await tick; for (let i = 0; i < 30; i++) { await settle(); await harness.tick(); }
  assert.equal(runs.get(run_id)!.status, "running", "no delivery while the chained revocation is pending");
  unblock(); await chained;
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.notEqual(runs.get(run_id)!.status, "running");
});

test("a failed active-run stop is retried to the end: the hung turn is aborted by the retry", async t => {
  let fail = true;
  const { harness, runtime, store, call } = await setup(t, { taskStopped: async () => { if (fail) { fail = false; throw Error("transient"); } } });
  await harness.sessionFor("api:issue-35");
  const session = runtime.sessions.get("api:issue-35")!; session.hold();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-35", session_id: "issue-35" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !harness.dispatchOrigin("api:issue-35"); i++) await settle();
  const child = await store.submit("api:issue-35", "req-35", "Update SHR-35", "direct", 1, harness.dependencyCheckpoint("api:issue-35"), undefined, harness.dispatchOrigin("api:issue-35"));
  await store.claim(child.id);
  let aborts = 0; session.abort = async () => { aborts++; }; // hung turn: abort does not end it
  await call("POST", `/v1/runs/${run_id}/stop`); // revocation fails once, before the stop's own abort
  for (let i = 0; i < 20; i++) await settle();
  const before = aborts;
  for (let i = 0; i < 30; i++) { await harness.tick(); await settle(); }
  assert.ok(aborts > before, `the retry aborts the hung turn (aborts ${before} -> ${aborts})`);
});

test("release delivery starts in the same step as its fence check: a close beginning right after the check is never bypassed", async t => {
  const { harness, runs, store, start } = await setup(t);
  const { run_id, child } = await start();
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "done");
  for (const e of store.events().filter(e => e.executionId === child.id)) await store.ack(e.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  assert.ok(task.apiHold, "held");
  const violations: string[] = []; let raced = false;
  const deliver = harness["deliver"].bind(harness);
  harness["deliver"] = (to: { target: string }, text: string, meta: unknown) => {
    if (to.target === run_id && (task.apiRevoking || harness["apiClosings"].has(task))) violations.push("delivered while revoking");
    return deliver(to, text, meta);
  };
  // The instant the release's fence check passes, a stop begins a close in the next microtask.
  const closings: Map<unknown, unknown> = harness["apiClosings"];
  const has = closings.has.bind(closings);
  (closings as { has: (k: unknown) => boolean }).has = (k: unknown) => {
    const r = has(k);
    if (k === task && !r && !raced && harness["apiReleasing"].has(task.apiHold)) {
      raced = true;
      const revoke = harness["revokeCancelledTask"].bind(harness);
      harness["revokeCancelledTask"] = async (...a: unknown[]) => { await new Promise<void>(res => setTimeout(res, 30)); return revoke(...a); };
      queueMicrotask(() => { void harness["closeApiWindow"](s, task, { id: "stop-race", source: "api", sessionKey: "api:issue-1", text: "", taskId: task.id }); });
    }
    return r;
  };
  for (let i = 0; i < 60 && runs.get(run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  for (let i = 0; i < 100 && harness["apiClosings"].get(task); i++) { await new Promise(r => setTimeout(r, 10)); await harness.tick(); await settle(); }
  assert.equal(raced, true, "the race was exercised");
  assert.deepEqual(violations, []);
});

test("a stop whose turn revocation fails is resumed in full by the retry before the fence lifts", async t => {
  let failStop = true; const stoppedTurns: string[] = [];
  const { harness, store, start } = await setup(t);
  const { child } = await start(); await store.claim(child.id);
  const stopTurn = store.stopTurn.bind(store);
  store.stopTurn = (async (turnId: string, key: string) => { if (failStop) { failStop = false; throw Error("transient stopTurn"); } stoppedTurns.push(turnId); return stopTurn(turnId, key); }) as typeof store.stopTurn;
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  const stop = { id: "stop-38", source: "api" as const, sessionKey: "api:issue-1", text: "", taskId: task.id, executionTurnId: "turn-38" };
  await assert.rejects(harness["closeApiWindow"](s, task, stop));
  assert.equal(task.apiRevoking, true, "fence stays after the failed stop");
  assert.equal(task.apiStop?.executionTurnId, "turn-38", "the stop intent is part of the durable fence");
  for (let i = 0; i < 30 && task.apiRevoking; i++) { await harness.tick(); await settle(); }
  assert.equal(task.apiRevoking, undefined);
  assert.deepEqual(stoppedTurns, ["turn-38"], "the retry resumed the complete stop (turn revoked) before lifting the fence");
});

test("fence and stop intent are persisted before the stop's first revocation step (restart resumes the stop)", async t => {
  const order: string[] = [];
  const { harness, store, start } = await setup(t);
  const { child } = await start(); await store.claim(child.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  const save = harness["onStateChange"];
  harness["onStateChange"] = async () => { order.push(`save:${task.apiRevoking}:${task.apiStop?.id}`); return save?.(); };
  const revoke = harness["revokeCancelledTask"].bind(harness);
  harness["revokeCancelledTask"] = async (...a: unknown[]) => { order.push("revoke"); return revoke(...a); };
  await harness["closeApiWindow"](s, task, { id: "stop-39", source: "api", sessionKey: "api:issue-1", text: "", taskId: task.id });
  assert.equal(order.indexOf("save:true:stop-39") >= 0 && order.indexOf("save:true:stop-39") < order.indexOf("revoke"), true, order.join(","));
  // A restart with a persisted stop intent reconstructs and resumes the stop.
  task.apiRevoking = true; task.apiStop = { id: "stop-40", text: "", taskId: task.id, executionTurnId: "turn-40" };
  const resumed: string[] = []; harness["revokeCancelledTask"] = async (_s: unknown, input: { id: string; executionTurnId?: string }) => { resumed.push(`${input.id}:${input.executionTurnId}`); };
  for (let i = 0; i < 30 && task.apiRevoking; i++) { await harness.tick(); await settle(); }
  assert.deepEqual(resumed, ["stop-40:turn-40"]);
  assert.equal(task.apiStop, undefined);
});

test("settlement replay replaces a checkpointed interim hold of the same run with the newer settled answer", async t => {
  const { harness, start } = await setup(t);
  const { run_id } = await start();
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiHold = { deadline: 2_000_000, entry: { id: "interim", sessionKey: "api:issue-1", to: { channel: "api", target: run_id }, text: "Interim" } };
  harness["replayHeldEntry"](task, { id: "final", sessionKey: "api:issue-1", to: { channel: "api", target: run_id }, text: "Final" }, 2_400_000, false);
  assert.equal(task.apiHold.entry.id, "final", "the newer settled answer of the same run wins");
  assert.equal(task.apiHold.deadline, 2_000_000, "never extended");
  harness["replayHeldEntry"](task, { id: "other", sessionKey: "api:issue-1", to: { channel: "api", target: "run_other" }, text: "Other" }, 2_000_000, false);
  assert.equal(task.apiHold.entry.id, "final", "a different run never takes over the hold");
  assert.deepEqual(task.apiDeferred?.map(e => e.id), ["other"]);
  harness["replayHeldEntry"](task, { id: "other2", sessionKey: "api:issue-1", to: { channel: "api", target: "run_other" }, text: "Other 2" }, 2_000_000, true);
  assert.deepEqual(task.apiDeferred?.map(e => e.id), ["other2"], "deferred answer of the same run replaced, not duplicated");
});

test("a stop joining while the prior close is saving performs its own save before revoking", async t => {
  const { harness, store, start } = await setup(t);
  const { child } = await start(); await store.claim(child.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  const saves: Array<string | undefined> = []; let releaseFirst!: () => void; let first = true;
  const save = harness["onStateChange"];
  harness["onStateChange"] = async () => {
    const snapshot = task.apiStop?.id; // what this save persists
    if (first) { first = false; await new Promise<void>(r => { releaseFirst = r; }); }
    saves.push(snapshot); return save?.();
  };
  const order: string[] = [];
  const revoke = harness["revokeCancelledTask"].bind(harness);
  harness["revokeCancelledTask"] = async (...a: unknown[]) => { order.push(`revoke after saves=${JSON.stringify(saves)}`); return revoke(...a); };
  harness["apiFencePersisted"].delete(task);
  const prior = harness["closeApiWindow"](s, task); await settle(); // its save is in flight (no stop intent yet)
  const stopping = harness["closeApiWindow"](s, task, { id: "stop-42", source: "api", sessionKey: "api:issue-1", text: "", taskId: task.id });
  releaseFirst(); await prior.catch(() => undefined); await stopping;
  assert.ok(order.length > 0 && JSON.parse(order[0].slice("revoke after saves=".length)).includes("stop-42"), order.join(" | "));
});

test("window close durably stops the current turn of the run before aborting it", async t => {
  const stopped: string[] = [];
  const { harness, runtime, store, call } = await setup(t);
  await harness.sessionFor("api:issue-43");
  const session = runtime.sessions.get("api:issue-43")!; session.hold();
  const stopTurn = store.stopTurn.bind(store);
  store.stopTurn = (async (id: string, key: string) => { stopped.push(id); return stopTurn(id, key).catch(() => undefined); }) as typeof store.stopTurn;
  await call("POST", "/v1/runs", { input: "Work SHR-43", session_id: "issue-43" });
  const s = harness.state("api:issue-43");
  for (let i = 0; i < 100 && !(s.running && s.current?.executionTurnId); i++) await settle();
  const turn = s.current!; assert.ok(turn.executionTurnId, "durable turn");
  const task = harness["apiTaskFor"](s, turn)!;
  await harness["closeApiWindow"](s, task);
  assert.ok(stopped.includes(turn.executionTurnId!), "the current turn was durably stopped under the fence");
});

test("an input arriving during revocation is durably stopped before it is dropped", async t => {
  const stopped: string[] = [];
  const { harness, store, start } = await setup(t);
  const { child } = await start(); await store.claim(child.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  const late = { id: "late-44", source: "host" as const, sessionKey: "api:issue-1", text: "late", taskId: task.id, executionTurnId: "turn-44" };
  const stopTurn = store.stopTurn.bind(store); let injected = false;
  store.stopTurn = (async (id: string, key: string) => { stopped.push(id); return stopTurn(id, key).catch(() => undefined); }) as typeof store.stopTurn;
  const abortTurn = harness["abortTaskTurn"].bind(harness); // runs after the first durable-turn scan
  harness["abortTaskTurn"] = async (...a: unknown[]) => { const r = await abortTurn(...a); if (!injected) { injected = true; s.queue.push(late as never); } return r; };
  await harness["closeApiWindow"](s, task);
  assert.equal(injected, true);
  assert.ok(!s.queue.includes(late as never), "dropped");
  assert.ok(stopped.includes("turn-44"), "its durable turn was stopped before it was dropped");
});

test("a child arriving for an already-revoked task during revocation is revoked before the fence lifts; no admission under the fence", async t => {
  const { harness, store, start } = await setup(t);
  const { child } = await start(); await store.claim(child.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  let late: { id: string } | undefined;
  const abortTurn = harness["abortTaskTurn"].bind(harness); // after the first revocation pass
  harness["abortTaskTurn"] = async (...a: unknown[]) => {
    const r = await abortTurn(...a);
    if (!late) {
      /* serialized submission-time admission refuses work under the fence, even from an earlier checkpoint */
      await assert.rejects(store.submit("api:issue-1", "req-late0", "Late child", "direct", 1, { taskId: task.id, depth: 1, original: task.original }), /API run is closing/);
      /* defence in depth: a child that bypassed admission is still revoked before the fence lifts */
      const guard = store.submitGuard; store.submitGuard = undefined;
      late = await store.submit("api:issue-1", "req-late", "Late child", "direct", 1, { taskId: task.id, depth: 1, original: task.original }); await store.claim(late.id);
      store.submitGuard = guard;
    }
    return r;
  };
  await harness["closeApiWindow"](s, task);
  assert.ok(late, "late child admitted for the already-revoked task");
  const record = store.list("api:issue-1").find(e => e.id === late!.id)!;
  assert.ok(record.parentStopped || !["ready", "running"].includes(record.status), `late child revoked: ${record.status}`);
  // Under the fence no new delegated work is admitted at all.
  task.apiRevoking = true;
  s.current = { id: "turn-x", source: "api", sessionKey: "api:issue-1", text: "x", taskId: task.id, replyTo: { channel: "api", target: "run_x" } } as never;
  assert.throws(() => harness.dependencyCheckpoint("api:issue-1"), /API run is closing/);
  task.apiRevoking = undefined; s.current = undefined;
});

test("a new API run that owns nothing yet can resume an older order; its window moves with it, never extended", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-26 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let observed: { error?: string; previous?: number; deadline?: number; old?: number; bound?: string } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-26"); const input = s.current!;
    const first = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
    const previous = first.apiRunDeadline;
    const error = await harness.operatorTaskDecision(ref.id, "reopen", "reopen-26", "Reopen SHR-26", "api:issue-26", input).then(() => "", e => String(e));
    assert.ok(first.apiRunEndedAt !== undefined, "the move-away fence of the old task is persisted state");
    observed = { error, previous, old: first.apiRunDeadline, bound: input.taskId,
      deadline: harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)?.apiRunDeadline };
    return "Reopened.";
  };
  await harness.accept({ id: "api:run_26", source: "api", sessionKey: "api:issue-26", text: "Reopen SHR-26", replyTo: { channel: "api", target: "run_26" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  assert.equal(observed!.error, "");
  assert.match(observed!.bound!, /^order:/);
  assert.ok(observed!.previous !== undefined);
  assert.equal(observed!.deadline, observed!.previous, "the window moved unchanged");
  assert.equal(observed!.old, undefined, "exactly one task carries the run window");
});

test("an API run that already owns delegated work is never rebound (refused before any write)", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-28 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let observed: { error: string; before?: string; after?: string; g0: number; g1: number } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-28"); const input = s.current!;
    await store.submit("api:issue-28", "req-28", "Update SHR-28", "direct", 1, harness.dependencyCheckpoint("api:issue-28"), undefined, harness.dispatchOrigin("api:issue-28"));
    const before = input.taskId; const g0 = store.coreTask(ref.id)!.generation;
    const error = await harness.operatorTaskDecision(ref.id, "reopen", "reopen-28", "Reopen", "api:issue-28", input).then(() => "", e => String(e));
    observed = { error, before, after: input.taskId, g0, g1: store.coreTask(ref.id)!.generation };
    return "Working.";
  };
  await harness.accept({ id: "api:run_28", source: "api", sessionKey: "api:issue-28", text: "Work SHR-28", replyTo: { channel: "api", target: "run_28" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  assert.match(observed!.error, /already owns delegated work/);
  assert.equal(observed!.after, observed!.before, "the run stays bound to its own task");
  assert.equal(observed!.g1, observed!.g0, "refusal writes nothing");
});

test("closing an operator task from an API run is still allowed", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original request", "operator", "operator");
  let result = "";
  runtime.answer = async () => {
    const s = harness.state("api:issue-27"); const input = s.current!;
    result = await harness.operatorTaskDecision(ref.id, "close", "close-27", "Done", "api:issue-27", input).catch(e => `ERR ${e}`);
    return "Closed.";
  };
  await harness.accept({ id: "api:run_27", source: "api", sessionKey: "api:issue-27", text: "Close it", replyTo: { channel: "api", target: "run_27" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !result; i++) await settle();
  assert.doesNotMatch(result, /^ERR/);
});

test("a later API run can resume an order an earlier, finished run had resumed", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-46 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  const errors: string[] = []; let done = 0;
  runtime.answer = async () => {
    const s = harness.state("api:issue-46"); const input = s.current!;
    errors.push(await harness.operatorTaskDecision(ref.id, done ? "clarify" : "reopen", `decide-46-${done}`, "Continue SHR-46", "api:issue-46", input).then(() => "", e => String(e)));
    done++; return "Continued.";
  };
  await harness.accept({ id: "api:run_46a", source: "api", sessionKey: "api:issue-46", text: "Reopen SHR-46", replyTo: { channel: "api", target: "run_46a" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && done < 1; i++) await settle();
  for (let i = 0; i < 50; i++) { await harness.tick(); await settle(); }
  await harness.accept({ id: "api:run_46b", source: "api", sessionKey: "api:issue-46", text: "Continue SHR-46", replyTo: { channel: "api", target: "run_46b" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && done < 2; i++) await settle();
  assert.deepEqual(errors, ["", ""], "the finished run no longer blocks the order");
});

test("a stop/close during the rebinding's awaits is fenced durably at once; the run stays and ends on its own task", async t => {
  let gate!: () => void; const gated = new Promise<void>(r => { gate = r; });
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true }, taskStopped: () => gated });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-47 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let observed: { error: string; text: string; own?: string; bound?: string; fencedAtOnce?: boolean; persisted?: boolean; deadline?: number } | undefined;
  let closing: Promise<void> | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-47"); const input = s.current!;
    const own = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
    const bind = store.bindTask.bind(store); let fencedAtOnce = false; let persisted = false;
    store.bindTask = (async (...a: Parameters<typeof store.bindTask>) => {
      closing = harness["closeApiWindow"](s, own, input); fencedAtOnce = !!own.apiRevoking && !!own.apiStop; /* a stop begins during the await */
      await settle(); persisted = !!harness.snapshotSessions().find(p => p.key === "api:issue-47")!.tasks!.find(x => x.id === own.id)!.apiStop;
      return bind(...a);
    }) as typeof store.bindTask;
    let text = "";
    const error = await harness.operatorTaskDecision(ref.id, "reopen", "reopen-47", "Reopen", "api:issue-47", input).then(r => { text = r; return ""; }, e => String(e));
    observed = { error, text, own: own.id, bound: input.taskId, fencedAtOnce, persisted, deadline: own.apiRunDeadline };
    return "Done.";
  };
  await harness.accept({ id: "api:run_47", source: "api", sessionKey: "api:issue-47", text: "Reopen SHR-47", replyTo: { channel: "api", target: "run_47" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  const o = observed!;
  assert.equal(o.fencedAtOnce, true, "the stop is fenced synchronously, not after the rebinding");
  assert.equal(o.persisted, true, "and its intent is part of the persisted state");
  assert.equal(o.error, ""); assert.match(o.text, /stays on its own task/);
  assert.equal(o.bound, o.own, "the run is not moved");
  assert.ok(o.deadline !== undefined, "its window stays on its own task");
  gate(); await closing;
});

test("an expired queued run whose cancelled delivery fails once still ends (durable outbox retry)", async t => {
  const { harness, runtime, runs, call, advance } = await setup(t);
  await harness.sessionFor("api:issue-48");
  const session = runtime.sessions.get("api:issue-48")!; session.hold();
  await call("POST", "/v1/runs", { input: "Earlier long run", session_id: "issue-48" });
  for (let i = 0; i < 100 && session.prompts.length < 1; i++) await settle();
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Work SHR-48", session_id: "issue-48" })).json() as { run_id: string };
  const channel = harness["channels"].get("api") as { send: (...a: unknown[]) => Promise<unknown> };
  const send = channel.send.bind(channel); let failed = false;
  channel.send = async (...a: unknown[]) => { if (!failed && (a[0] as { target: string }).target === run_id) { failed = true; throw Error("transient delivery failure"); } return send(...a); };
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  for (let i = 0; i < 200 && runs.get(run_id)!.status === "queued"; i++) { await harness.tick(); await settle(); }
  assert.equal(failed, true, "the first delivery failed");
  assert.equal(runs.get(run_id)!.status, "cancelled");
});

test("a checkpoint captured before a rebinding cannot carry work past it: refused or the rebinding is refused", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-49 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let observed: { submit: string; rebind: string; own?: string; bound?: string; children: string[] } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-49"); const input = s.current!; const own = input.taskId!;
    const checkpoint = harness.dependencyCheckpoint("api:issue-49"); /* captured before the rebinding */
    const rebinding = harness.operatorTaskDecision(ref.id, "reopen", "reopen-49", "Reopen", "api:issue-49", input).then(() => "", e => String(e));
    const submit = await store.submit("api:issue-49", "req-49", "Update SHR-49", "direct", 1, checkpoint, undefined, harness.dispatchOrigin("api:issue-49")).then(() => "", e => String(e));
    const rebind = await rebinding;
    observed = { submit, rebind, own, bound: input.taskId, children: store.list("api:issue-49").map(e => e.dependency!.taskId) };
    return "Done.";
  };
  await harness.accept({ id: "api:run_49", source: "api", sessionKey: "api:issue-49", text: "Work SHR-49", replyTo: { channel: "api", target: "run_49" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  const o = observed!;
  if (o.submit === "") {
    assert.match(o.rebind, /already owns delegated work/, "work admitted first: the run is not rebound");
    assert.equal(o.bound, o.own);
  } else {
    assert.match(o.submit, /rebound|closing/);
    assert.equal(o.children.length, 0);
  }
  for (const taskId of o.children) assert.equal(taskId, o.bound, "every child belongs to the task carrying the run");
});

test("a checkpoint captured under an API run that has since ended admits no delegated work", async t => {
  const { harness, runtime, runs, store } = await setup(t);
  let checkpoint: ReturnType<typeof harness.dependencyCheckpoint>;
  runtime.answer = async () => { checkpoint = harness.dependencyCheckpoint("api:issue-50"); return "Done without workers."; };
  await harness.accept({ id: "api:run_50", source: "api", sessionKey: "api:issue-50", text: "Work SHR-50", replyTo: { channel: "api", target: "run_50" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !checkpoint; i++) await settle();
  for (let i = 0; i < 50; i++) await settle();
  assert.ok(checkpoint, "checkpoint captured under the run");
  await assert.rejects(store.submit("api:issue-50", "req-50", "Late work", "direct", 1, checkpoint, undefined, { channel: "api", target: "run_50" }), /has ended/);
  assert.equal(store.list("api:issue-50").length, 0);
  void runs;
});

test("a late result for a closed order never ends an open API run whose other work is live", async t => {
  const { harness, runs, store, start } = await setup(t);
  const { run_id, child } = await start(); await store.claim(child.id); /* live child of the open run */
  (harness.opts as { taskLifecycle?: { enabled: boolean } }).taskLifecycle = { enabled: true };
  const ref = await store.enrollTask("old-room", "old", "Closed order", "operator", "operator");
  const old = await store.submit("api:issue-1", "req-old", "Old work", "direct", 1, { taskId: "old-task", depth: 0, original: "Closed order", taskRef: ref }, undefined, { channel: "api", target: run_id });
  const claim = await store.claim(old.id); await store.complete(old.id, claim.token!, "late old result");
  await store.decideTask(ref, ref.generation, "done", "close", "done");
  await harness.accept({ id: `dispatch-event:late-${old.id}`, source: "host", sessionKey: "api:issue-1", hostEvent: { executionId: old.id },
    text: `Dispatcher result (data, not new authorization) for ${old.id}:\nlate old result`, replyTo: { channel: "api", target: run_id } });
  for (let i = 0; i < 100; i++) await settle();
  await harness.tick(); await settle();
  assert.equal(runs.get(run_id)!.status, "running", "the late historical result is progress, not the run's end");
});

test("admission is bound to the run identity: a delayed submission of an ended run A never enters run B's window on the same order", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-51 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let phase = 0; let checkpointA: ReturnType<typeof harness.dependencyCheckpoint>; let observed: { submit: string; bound?: string } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-51"); const input = s.current!;
    if (phase === 0) {
      await harness.operatorTaskDecision(ref.id, "reopen", "reopen-51", "Reopen", "api:issue-51", input);
      checkpointA = harness.dependencyCheckpoint("api:issue-51"); phase = 1; return "A done.";
    }
    await harness.operatorTaskDecision(ref.id, "clarify", "clarify-51", "Continue", "api:issue-51", input);
    /* run A's delayed submission arrives while run B carries the same order */
    const submit = await store.submit("api:issue-51", "req-51a", "A's late work", "direct", 1, checkpointA, undefined, { channel: "api", target: "run_51a" }).then(() => "", e => String(e));
    const originless = await store.submit("api:issue-51", "req-51c", "A's late work, no origin", "direct", 1, checkpointA).then(() => "", e => String(e));
    assert.match(originless, /no longer carries this task/, "an origin-less submission is refused too");
    observed = { submit, bound: input.taskId }; phase = 2; return "B done.";
  };
  await harness.accept({ id: "api:run_51a", source: "api", sessionKey: "api:issue-51", text: "Reopen SHR-51", replyTo: { channel: "api", target: "run_51a" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && phase < 1; i++) await settle();
  for (let i = 0; i < 50; i++) { await harness.tick(); await settle(); }
  await harness.accept({ id: "api:run_51b", source: "api", sessionKey: "api:issue-51", text: "Continue SHR-51", replyTo: { channel: "api", target: "run_51b" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && phase < 2; i++) await settle();
  assert.equal(checkpointA?.taskId, observed!.bound, "both runs carry the same order task");
  assert.match(observed!.submit, /no longer carries this task/);
  assert.equal(store.list("api:issue-51").length, 0);
});

test("a later run can rebind back onto a task an earlier run had moved away from, and delegate there", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const refA = await store.enrollTask("old-room", "oldA", "Order A", "operator", "operator"); await store.decideTask(refA, 1, "doneA", "close", "done");
  const refB = await store.enrollTask("old-room", "oldB", "Order B", "operator", "operator"); await store.decideTask(refB, 1, "doneB", "close", "done");
  let phase = 0; const errors: string[] = [];
  runtime.answer = async () => {
    const s = harness.state("api:issue-52"); const input = s.current!;
    if (phase === 0) { await harness.operatorTaskDecision(refA.id, "reopen", "reopen-52a", "Reopen A", "api:issue-52", input); phase = 1; return "A."; }
    if (phase === 1) {
      await harness.operatorTaskDecision(refA.id, "clarify", "clarify-52a", "A again", "api:issue-52", input); /* run 2 on A ... */
      await harness.operatorTaskDecision(refB.id, "reopen", "reopen-52b", "Now B", "api:issue-52", input); /* ... then moves away from A to B */
      phase = 2; return "B.";
    }
    /* run 3 returns to A and must still be able to delegate there */
    const a = store.coreTask(refA.id)!;
    await harness.operatorTaskDecision(refA.id, a.operatorStatus === "open" ? "clarify" : "reopen", "decide-52a3", "A third", "api:issue-52", input);
    errors.push(await store.submit("api:issue-52", "req-52", "Work on A", "direct", 1, harness.dependencyCheckpoint("api:issue-52"), undefined, harness.dispatchOrigin("api:issue-52")).then(() => "", e => String(e)));
    phase = 3; return "A third.";
  };
  for (const [n, p] of [["1", 1], ["2", 2], ["3", 3]] as const) {
    await harness.accept({ id: `api:run_52_${n}`, source: "api", sessionKey: "api:issue-52", text: `Run ${n}`, replyTo: { channel: "api", target: `run_52_${n}` }, apiAcceptedAt: 1_000_000 });
    for (let i = 0; i < 2000 && phase < p; i++) await settle();
    for (let i = 0; i < 30; i++) { await harness.tick(); await settle(); }
  }
  assert.deepEqual(errors, [""], "delegation works on the re-entered task");
});

test("rebinding never extends authority: the earlier expiry of the previous task bounds the bound task", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order", "operator", "operator"); await store.decideTask(ref, 1, "done", "close", "done");
  let observed: { previous?: number; bound?: number; turn?: number } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-53"); const input = s.current!;
    const own = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
    own.expiresAt = 1_000_500; /* the previous task's earlier expiry */
    await harness.operatorTaskDecision(ref.id, "reopen", "reopen-53", "Reopen", "api:issue-53", input);
    const bound = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
    observed = { previous: own.expiresAt, bound: bound.expiresAt, turn: input.continuationExpiresAt };
    return "Done.";
  };
  await harness.accept({ id: "api:run_53", source: "api", sessionKey: "api:issue-53", text: "Reopen", replyTo: { channel: "api", target: "run_53" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  assert.ok(observed!.bound! <= 1_000_500, `bound task expiry ${observed!.bound}`);
  assert.ok(observed!.turn! <= 1_000_500);
});

test("the move-away fence is persisted: after a restart a stale checkpoint of the old task is refused; a later run carrying it again is admitted", async t => {
  const { harness, start } = await setup(t);
  await start();
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiRunDeadline = undefined; task.apiRunId = undefined; task.apiRunEndedAt = 1_000_000; /* as persisted by a move-away */
  harness["apiReboundTo"] = new WeakMap(); /* in-memory markers are gone after a restart */
  assert.throws(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_earlier" }), /has ended/);
  assert.throws(() => harness["guardApiAdmission"]("api:issue-1", task.id, undefined), /has ended/);
  task.apiRunId = "run_later"; task.apiRunDeadline = 2_000_000; /* a later run carries it again */
  assert.doesNotThrow(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_later" }));
  assert.throws(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_earlier" }), /no longer carries/);
});

test("a later run resuming an order after the earlier run's deadline gets its own bounded authority", async t => {
  const { harness, runtime, store, advance } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-54", "operator", "operator"); await store.decideTask(ref, 1, "done", "close", "done");
  let phase = 0; let observed: { error: string; turn?: number; now: number } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-54"); const input = s.current!;
    if (phase === 0) { await harness.operatorTaskDecision(ref.id, "reopen", "reopen-54", "Reopen", "api:issue-54", input); phase = 1; return "A."; }
    await harness.operatorTaskDecision(ref.id, "clarify", "clarify-54", "Continue", "api:issue-54", input);
    const error = await store.submit("api:issue-54", "req-54", "Work", "direct", 1, harness.dependencyCheckpoint("api:issue-54"), undefined, harness.dispatchOrigin("api:issue-54")).then(() => "", e => String(e));
    observed = { error, turn: input.continuationExpiresAt, now: harness["now"]() }; phase = 2; return "B.";
  };
  await harness.accept({ id: "api:run_54a", source: "api", sessionKey: "api:issue-54", text: "Reopen", replyTo: { channel: "api", target: "run_54a" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && phase < 1; i++) await settle();
  for (let i = 0; i < 30; i++) { await harness.tick(); await settle(); }
  advance(DEFAULT_API_RESULT_HOLD_MS * 3); /* well past run A's window */
  await harness.accept({ id: "api:run_54b", source: "api", sessionKey: "api:issue-54", text: "Continue", replyTo: { channel: "api", target: "run_54b" }, apiAcceptedAt: 1_000_000 + DEFAULT_API_RESULT_HOLD_MS * 3 });
  for (let i = 0; i < 2000 && phase < 2; i++) await settle();
  assert.equal(observed!.error, "");
  assert.ok(observed!.turn! > observed!.now, "the later run's authority is not the expired predecessor's");
  assert.ok(observed!.turn! <= observed!.now + DEFAULT_API_RESULT_HOLD_MS, "and bounded by its own window");
});

test("an interrupted rebinding (failed write after the decision) leaves the run on its own task; the order can be resumed later", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-55", "operator", "operator"); await store.decideTask(ref, 1, "done", "close", "done");
  let phase = 0; let observed: { error: string; own?: string; bound?: string; deadline?: number; runId?: string; intent?: number; admit: string; later?: string } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-55"); const input = s.current!;
    if (phase === 0) {
      const own = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
      const bind = store.bindTask.bind(store);
      store.bindTask = (async () => { throw Error("crash between durable writes"); }) as typeof store.bindTask;
      const error = await harness.operatorTaskDecision(ref.id, "reopen", "reopen-55", "Reopen", "api:issue-55", input).then(() => "", e => String(e));
      store.bindTask = bind;
      const admit = (() => { try { harness["guardApiAdmission"]("api:issue-55", own.id, { channel: "api", target: "run_55a" }); return ""; } catch (e) { return String(e); } })();
      observed = { error, own: own.id, bound: input.taskId, deadline: own.apiRunDeadline, runId: own.apiRunId, intent: own.apiRebindIntent, admit };
      phase = 1; return "A.";
    }
    const later = await harness.operatorTaskDecision(ref.id, store.coreTask(ref.id)!.operatorStatus === "open" ? "clarify" : "reopen", "decide-55b", "Continue", "api:issue-55", input).then(() => "", e => String(e));
    observed!.later = later; phase = 2; return "B.";
  };
  await harness.accept({ id: "api:run_55a", source: "api", sessionKey: "api:issue-55", text: "Reopen", replyTo: { channel: "api", target: "run_55a" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && phase < 1; i++) await settle();
  const o = observed!;
  assert.match(o.error, /crash between durable writes/);
  assert.equal(o.bound, o.own, "the run's turn stays on its own task");
  assert.ok(o.deadline !== undefined); assert.equal(o.runId, "run_55a"); assert.equal(o.intent, undefined, "intent retired");
  assert.equal(o.admit, "", "its own run's work is admitted normally");
  for (let i = 0; i < 30; i++) { await harness.tick(); await settle(); }
  await harness.accept({ id: "api:run_55b", source: "api", sessionKey: "api:issue-55", text: "Continue", replyTo: { channel: "api", target: "run_55b" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && phase < 2; i++) await settle();
  assert.equal(o.later, "", "a later run can still resume the order");
});

test("a rebinding intent restored after a crash is retired; the run stays on its task and no work is admitted while it is pending", async t => {
  const { harness, start } = await setup(t);
  await start();
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiRunId = "run_x"; task.apiRebindIntent = 1_000_000;
  assert.throws(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_x" }), /rebound/);
  const snapshot = harness.snapshotSessions().find(p => p.key === "api:issue-1")!;
  assert.equal(snapshot.tasks!.find(x => x.id === task.id)!.apiRebindIntent, 1_000_000, "the intent is persisted state");
  harness.restoreSessions([snapshot]);
  const restored = harness["tasks"](harness.state("api:issue-1")).find((x: { id: string }) => x.id === task.id)!;
  assert.equal(restored.apiRebindIntent, undefined);
  assert.equal(restored.apiRunId, "run_x", "the run stays on its task");
  assert.doesNotThrow(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_x" }));
});

test("a delayed submission after the run window passed is refused even before the tick raises the fence", async t => {
  const { harness, start, advance } = await setup(t);
  await start();
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiRunId = "run_y";
  assert.doesNotThrow(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_y" }));
  advance(DEFAULT_API_RESULT_HOLD_MS + 1); /* no tick: no fence yet */
  assert.equal(task.apiRevoking, undefined);
  assert.throws(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_y" }), /window has closed/);
});

test("a rebinding whose final save fails keeps both tasks fenced until a later save covers the move", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-56", "operator", "operator"); await store.decideTask(ref, 1, "done", "close", "done");
  let fail = false; let saves = 0;
  harness.onStateChange = async () => { saves++; if (fail) throw Error("disk full"); };
  let observed: { error: string; own?: { id: string }; bound?: { id: string } } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-56"); const input = s.current!;
    const own = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
    const decide = store.bindTask.bind(store);
    store.bindTask = (async (...a: Parameters<typeof store.bindTask>) => { const r = await decide(...a); fail = true; return r; }) as typeof store.bindTask;
    const error = await harness.operatorTaskDecision(ref.id, "reopen", "reopen-56", "Reopen", "api:issue-56", input).then(() => "", e => String(e));
    store.bindTask = decide;
    observed = { error, own, bound: harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId) };
    return "Done.";
  };
  await harness.accept({ id: "api:run_56", source: "api", sessionKey: "api:issue-56", text: "Reopen", replyTo: { channel: "api", target: "run_56" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  const o = observed!;
  assert.match(o.error, /disk full/);
  for (const task of [o.own!, o.bound!]) assert.throws(() => harness["guardApiAdmission"]("api:issue-56", task.id, { channel: "api", target: "run_56" }), /rebound/, `fenced: ${task.id}`);
  fail = false;
  for (let i = 0; i < 200 && (o.bound as { apiRebindIntent?: number }).apiRebindIntent !== undefined; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal((o.bound as { apiRebindIntent?: number }).apiRebindIntent, undefined, "the fence lifts once a later save covered the move");
  assert.equal((o.own as { apiRebindIntent?: number }).apiRebindIntent, undefined);
  assert.ok(saves >= 3, "the move was saved again");
});

test("rebinding never adopts another mandate's work on the destination order", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-57", "operator", "operator");
  /* the open order already has work of another (non-API) mandate */
  await store.submit("old-room", "req-57", "Other mandate's work", "direct", 1, { taskId: `order:${ref.id}:${ref.generation}`, depth: 0, original: "Order SHR-57", taskRef: ref });
  let error = "";
  runtime.answer = async () => {
    const s = harness.state("api:issue-57"); const input = s.current!;
    error = await harness.operatorTaskDecision(ref.id, "clarify", "clarify-57", "Continue", "api:issue-57", input).then(() => "", e => String(e));
    return "Done.";
  };
  await harness.accept({ id: "api:run_57", source: "api", sessionKey: "api:issue-57", text: "Continue", replyTo: { channel: "api", target: "run_57" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !error; i++) await settle();
  assert.match(error, /already owns delegated work|belongs to another run/);
});

test("a run whose native child already settled still owns that work and is never rebound", async t => {
  let owned = false;
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true }, nativeOwned: () => owned });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-58", "operator", "operator"); await store.decideTask(ref, 1, "done", "close", "done");
  let error = "";
  runtime.answer = async () => {
    const s = harness.state("api:issue-58"); const input = s.current!;
    owned = true; /* a native child ran and settled under this run */
    error = await harness.operatorTaskDecision(ref.id, "reopen", "reopen-58", "Reopen", "api:issue-58", input).then(() => "", e => String(e));
    return "Done.";
  };
  await harness.accept({ id: "api:run_58", source: "api", sessionKey: "api:issue-58", text: "Work", replyTo: { channel: "api", target: "run_58" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !error; i++) await settle();
  assert.match(error, /already owns delegated work/);
});

test("native admission is synchronous with its checkpoint: during a rebinding it is refused, after it the work is owned", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-59", "operator", "operator"); await store.decideTask(ref, 1, "done", "close", "done");
  let observed: string | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-59"); const input = s.current!;
    const rebinding = harness.operatorTaskDecision(ref.id, "reopen", "reopen-59", "Reopen", "api:issue-59", input).then(() => "", e => String(e));
    /* a native start in the same window captures its checkpoint synchronously */
    observed = (() => { try { harness.dependencyCheckpoint("api:issue-59"); return "admitted"; } catch (e) { return String(e); } })();
    await rebinding; return "Done.";
  };
  await harness.accept({ id: "api:run_59", source: "api", sessionKey: "api:issue-59", text: "Work", replyTo: { channel: "api", target: "run_59" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  assert.match(observed!, /being rebound/);
});

test("work reaching the destination during the rebinding's awaits is never adopted: the run stays on its task", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-60", "operator", "operator"); await store.decideTask(ref, 1, "done", "close", "done");
  let observed: { error: string; text: string; own?: string; bound?: string; destRun?: string } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-60"); const input = s.current!; const own = input.taskId;
    const bind = store.bindTask.bind(store);
    store.bindTask = (async (...a: Parameters<typeof store.bindTask>) => {
      await bind(...a); /* another mandate submits for the destination during the awaits */
      await store.submit("old-room", "req-60", "Other work", "direct", 1, { taskId: a[1], depth: 0, original: "Order SHR-60", taskRef: a[2] });
    }) as typeof store.bindTask;
    let text = "";
    const error = await harness.operatorTaskDecision(ref.id, "reopen", "reopen-60", "Reopen", "api:issue-60", input).then(r => { text = r; return ""; }, e => String(e));
    store.bindTask = bind;
    const dest = harness["tasks"](s).find((x: { id: string }) => x.id.startsWith(`order:${ref.id}:`));
    observed = { error, text, own, bound: input.taskId, destRun: dest?.apiRunId };
    return "Done.";
  };
  await harness.accept({ id: "api:run_60", source: "api", sessionKey: "api:issue-60", text: "Reopen", replyTo: { channel: "api", target: "run_60" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  const o = observed!;
  assert.equal(o.error, ""); assert.match(o.text, /stays on its own task/);
  assert.equal(o.bound, o.own, "the run is not moved onto the other mandate's work");
  assert.equal(o.destRun, undefined);
});

test("a destination submission still being written when the move happens is never adopted", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-61", "operator", "operator"); await store.decideTask(ref, 1, "done", "close", "done");
  let observed: { text: string; own?: string; bound?: string } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-61"); const input = s.current!; const own = input.taskId;
    const bind = store.bindTask.bind(store);
    store.bindTask = (async (...a: Parameters<typeof store.bindTask>) => {
      await bind(...a);
      /* a foreign submission passes the guard; its ledger write is still pending at the move */
      const guard = store.submitGuard!; let admitted!: () => void; const passed = new Promise<void>(r => { admitted = r; });
      store.submitGuard = (...g) => { guard(...g); admitted(); };
      void store.submit("old-room", "req-61", "Other work", "direct", 1, { taskId: a[1], depth: 0, original: "Order SHR-61", taskRef: a[2] }).catch(() => undefined);
      await passed; store.submitGuard = guard;
      assert.equal(store.submissionInFlight(a[1]), true, "admitted, write pending");
    }) as typeof store.bindTask;
    const text = await harness.operatorTaskDecision(ref.id, "reopen", "reopen-61", "Reopen", "api:issue-61", input).catch(e => String(e));
    store.bindTask = bind;
    observed = { text, own, bound: input.taskId };
    return "Done.";
  };
  await harness.accept({ id: "api:run_61", source: "api", sessionKey: "api:issue-61", text: "Reopen", replyTo: { channel: "api", target: "run_61" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  assert.match(observed!.text, /stays on its own task/);
  assert.equal(observed!.bound, observed!.own);
});

test("an order with only terminal execution history can be resumed by a later API run", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-62", "operator", "operator");
  const old = await store.submit("old-room", "req-62", "Old work", "direct", 1, { taskId: `order:${ref.id}:${ref.generation}`, depth: 0, original: "Order SHR-62", taskRef: ref });
  const c = await store.claim(old.id); await store.complete(old.id, c.token!, "done");
  let observed: { error: string; bound?: string } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-62"); const input = s.current!;
    const error = await harness.operatorTaskDecision(ref.id, "clarify", "clarify-62", "Continue", "api:issue-62", input).then(r => /stays on its own task/.test(r) ? "not moved" : "", e => String(e));
    observed = { error, bound: input.taskId }; return "Done.";
  };
  await harness.accept({ id: "api:run_62", source: "api", sessionKey: "api:issue-62", text: "Continue", replyTo: { channel: "api", target: "run_62" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  assert.equal(observed!.error, "");
  assert.equal(observed!.bound, `order:${ref.id}:${ref.generation}`);
});

test("the admission guard applies to a task carried by an API run in another session", async t => {
  const { harness, start } = await setup(t);
  await start();
  const task = harness["tasks"](harness.state("api:issue-1"))[0];
  task.apiRunId = "run_owner";
  assert.throws(() => harness["guardApiAdmission"]("other-room", task.id, { channel: "matrix", target: "!room" }), /another session/);
  assert.throws(() => harness["guardApiAdmission"]("other-room", task.id, undefined), /another session/);
  /* even with the carrier's run identity: the run's liveness/revocation only see its own session */
  assert.throws(() => harness["guardApiAdmission"]("other-room", task.id, { channel: "api", target: "run_owner" }), /another session/);
  assert.doesNotThrow(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_owner" }));
});

test("no delegated work is admitted while the run's terminal result is being delivered", async t => {
  const { harness, start } = await setup(t);
  await start();
  const task = harness["tasks"](harness.state("api:issue-1"))[0];
  task.apiRunId = "run_owner";
  task.apiHold = { deadline: 0, entry: { id: "h", sessionKey: "api:issue-1", to: { channel: "api", target: "run_owner" }, text: "x" } } as never;
  assert.doesNotThrow(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_owner" }));
  harness["apiReleasing"].add(task.apiHold);
  assert.throws(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_owner" }), /finishing/);
});

test("native admission (dependencyCheckpoint) honours the persisted rebinding fence, the window and the run identity", async t => {
  const { harness, start, advance } = await setup(t);
  await start();
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  s.current = { id: "turn-n", source: "api", sessionKey: "api:issue-1", text: "x", taskId: task.id, replyTo: { channel: "api", target: "run_n" } } as never;
  task.apiRunId = "run_n";
  assert.doesNotThrow(() => harness.dependencyCheckpoint("api:issue-1"));
  task.apiRebindIntent = 1; /* final rebinding save failed: in-memory map entry already gone */
  assert.throws(() => harness.dependencyCheckpoint("api:issue-1"), /rebound/);
  task.apiRebindIntent = undefined; task.apiRunId = "run_other";
  assert.throws(() => harness.dependencyCheckpoint("api:issue-1"), /no longer carries/);
  task.apiRunId = "run_n"; advance(DEFAULT_API_RESULT_HOLD_MS * 2);
  assert.throws(() => harness.dependencyCheckpoint("api:issue-1"), /window has closed/);
  s.current = undefined;
});

test("live native work of another session on the destination order is never adopted", async t => {
  let foreignNative = false;
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true }, nativeLiveForTask: () => foreignNative });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-63", "operator", "operator");
  let error = ""; let observed = false;
  runtime.answer = async () => {
    const s = harness.state("api:issue-63"); const input = s.current!;
    foreignNative = true; /* another session runs a native child for the order */
    error = await harness.operatorTaskDecision(ref.id, "clarify", "clarify-63", "Continue", "api:issue-63", input).then(r => /stays on its own task/.test(r) ? "not moved" : "", e => String(e));
    observed = true; return "Done.";
  };
  await harness.accept({ id: "api:run_63", source: "api", sessionKey: "api:issue-63", text: "Continue", replyTo: { channel: "api", target: "run_63" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !observed; i++) await settle();
  assert.match(error, /already owns delegated work|belongs to another run|not moved/);
});

test("replay exhaustion of an API turn with a live child revokes the child before the run fails", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-replay-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const child = await store.submit("api:issue-64", "req-64", "Update SHR-64", "direct", 1, { taskId: "t64", original: "Work SHR-64", depth: 0, expiresAt: 5_000_000 });
  await store.claim(child.id);
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const record = runs.create({ session_key: "api:issue-64" }); runs.started(record.run_id); await runs.save();
  const harness = new Harness({ runtime: new FakeRuntime(), executionStore: store, tickMs: 600_000, log: () => {}, now: () => 1_000_100 });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  harness.addChannel(api); harness.onStateChange = async () => {};
  harness.restoreSessions([{ key: "api:issue-64", tasks: [{ id: "t64", original: "Work SHR-64", state: "active", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 1_000_000 + DEFAULT_API_RESULT_HOLD_MS, apiRunId: record.run_id }] }]);
  harness.restorePending([{ id: "api:turn-64", source: "api", sessionKey: "api:issue-64", text: "Work SHR-64", taskId: "t64", started: true, replays: 3,
    replyTo: { channel: "api", target: record.run_id } }]);
  const task = harness["tasks"](harness.state("api:issue-64"))[0];
  assert.ok(task.apiHold, "the failure is held, not staged directly in the outbox");
  await harness.start(); t.after(() => harness.stop(0)); harness.releaseRestored();
  for (let i = 0; i < 5; i++) { await harness.tick(); for (let j = 0; j < 50 && runs.get(record.run_id)!.status === "running"; j++) await settle(); }
  assert.equal(runs.get(record.run_id)!.status, "failed");
  assert.equal(store.list()[0].status, "cancelled", "the live child was revoked before the run failed");
});

test("two API runs in different sessions can never both take the same order", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order SHR-65", "operator", "operator");
  const results: Record<string, string> = {}; const bound: Record<string, string | undefined> = {};
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const bind = store.bindTask.bind(store);
  store.bindTask = (async (...a: Parameters<typeof store.bindTask>) => { await gate; return bind(...a); }) as typeof store.bindTask;
  runtime.answer = async (_text, key) => {
    const s = harness.state(key!); const input = s.current!;
    results[key!] = await harness.operatorTaskDecision(ref.id, "clarify", `clarify-${key}`, "Continue", key!, input).then(r => /stays on its own task/.test(r) ? "not moved" : "moved", e => String(e));
    bound[key!] = input.taskId; return "Done.";
  };
  await harness.accept({ id: "api:run_65a", source: "api", sessionKey: "api:issue-65a", text: "A", replyTo: { channel: "api", target: "run_65a" }, apiAcceptedAt: 1_000_000 });
  await harness.accept({ id: "api:run_65b", source: "api", sessionKey: "api:issue-65b", text: "B", replyTo: { channel: "api", target: "run_65b" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 200; i++) await settle();
  release();
  for (let i = 0; i < 2000 && Object.keys(results).length < 2; i++) await settle();
  const order = Object.values(bound).filter(id => id?.startsWith(`order:${ref.id}:`));
  assert.equal(order.length, 1, `exactly one run carries the order: ${JSON.stringify(results)}`);
});

test("the order carrier check spans sessions and in-flight rebindings", async t => {
  const { harness, start } = await setup(t);
  await start();
  const other = harness.state("api:issue-other"); const mine = harness["tasks"](harness.state("api:issue-1"))[0];
  other.tasks = [{ id: "order:o66:1", original: "x", depth: 0, state: "active", recoveryEnrollment: "current", apiRunDeadline: 2_000_000, apiRunId: "run_other" }] as never;
  assert.ok(harness["orderApiCarrier"]("o66", mine), "a carrier in another session is found");
  other.tasks = [];
  harness["apiRebindingOrders"].set(other as never, "o66");
  assert.ok(harness["orderApiCarrier"]("o66", mine), "an in-flight rebinding in another session is found");
  harness["apiRebindingOrders"].delete(other as never);
  assert.equal(harness["orderApiCarrier"]("o66", mine), undefined);
});

for (const variant of ["no live work", "restored revocation fence"] as const) test(`replay exhaustion with ${variant} still ends the run through the hold and retires its carrier`, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "api-hold-replay2-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  let gate!: () => void; const gated = new Promise<void>(r => { gate = r; });
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const record = runs.create({ session_key: "api:issue-67" }); runs.started(record.run_id); await runs.save();
  const harness = new Harness({ runtime: new FakeRuntime(), executionStore: store, tickMs: 600_000, log: () => {}, now: () => 1_000_100,
    ...(variant === "restored revocation fence" ? { taskStopped: () => gated } : {}) });
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "minerva", runs, cancel: (k, id) => harness.cancel(k, id), models: async () => [], log: () => {} });
  harness.addChannel(api); harness.onStateChange = async () => {};
  harness.restoreSessions([{ key: "api:issue-67", tasks: [{ id: "order:o67:1", original: "Work", state: "active", depth: 0, recoveryEnrollment: "current",
    apiRunDeadline: 1_000_000 + DEFAULT_API_RESULT_HOLD_MS, apiRunId: record.run_id, ...(variant === "restored revocation fence" ? { apiRevoking: true, apiRevokingRun: record.run_id } : {}) }] }]);
  harness.restorePending([{ id: "api:turn-67", source: "api", sessionKey: "api:issue-67", text: "Work", taskId: "order:o67:1", started: true, replays: 3,
    replyTo: { channel: "api", target: record.run_id } }]);
  const task = harness["tasks"](harness.state("api:issue-67"))[0];
  assert.ok(task.apiHold, "the failure is held");
  await harness.start(); t.after(() => harness.stop(0)); harness.releaseRestored();
  for (let i = 0; i < 3; i++) { await harness.tick(); for (let j = 0; j < 30; j++) await settle(); }
  if (variant === "restored revocation fence") {
    assert.equal(runs.get(record.run_id)!.status, "running", "never delivered before the restored fence completed");
    gate();
  }
  for (let i = 0; i < 5; i++) { await harness.tick(); for (let j = 0; j < 50 && runs.get(record.run_id)!.status === "running"; j++) await settle(); }
  assert.notEqual(runs.get(record.run_id)!.status, "running");
  assert.equal(task.apiRunDeadline, undefined, "the carrier is retired");
  assert.equal(harness["orderApiCarrier"]("o67"), undefined);
});

test("a finished API run fences only stale API authority, never a later non-API mandate on the order", async t => {
  const { harness, start } = await setup(t);
  await start();
  const task = harness["tasks"](harness.state("api:issue-1"))[0];
  task.apiRunDeadline = undefined; task.apiRunId = undefined; task.apiRunEndedAt = 123;
  assert.throws(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "api", target: "run_old" }), /has ended/);
  assert.doesNotThrow(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "matrix", target: "!room" }));
  assert.doesNotThrow(() => harness["guardApiAdmission"]("other-room", task.id, { channel: "matrix", target: "!room" }), "cross-session operator work resumes");
  assert.throws(() => harness["guardApiAdmission"]("other-room", task.id, undefined), /has ended/, "origin-less work carries no new mandate");
});

test("a local ended-run record never hides a live carrier of the same task in another session", async t => {
  const { harness, start } = await setup(t);
  await start();
  const task = harness["tasks"](harness.state("api:issue-1"))[0];
  task.apiRunDeadline = undefined; task.apiRunId = undefined; task.apiRunEndedAt = 123;
  const other = harness.state("api:issue-carrier");
  other.tasks = [{ ...structuredClone(task), apiRunEndedAt: undefined, apiRunId: "run_live", apiRunDeadline: 5_000_000 }] as never;
  assert.throws(() => harness["guardApiAdmission"]("api:issue-1", task.id, { channel: "matrix", target: "!room" }), /another session/);
  assert.doesNotThrow(() => harness["guardApiAdmission"]("api:issue-carrier", task.id, { channel: "api", target: "run_live" }));
});
