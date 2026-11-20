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

test("rebinding an API turn to a reopened operator task keeps the run's acceptance-anchored window", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-26 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let observed: { deadline?: number; previous?: number } = {};
  runtime.answer = async () => {
    const s = harness.state("api:issue-26"); const input = s.current!;
    const previous = harness["tasks"](s).find((t: { id: string }) => t.id === input.taskId)?.apiRunDeadline;
    await harness.operatorTaskDecision(ref.id, "reopen", "reopen-26", "Reopen SHR-26", "api:issue-26", input);
    observed = { previous, deadline: harness["tasks"](s).find((t: { id: string }) => t.id === input.taskId)?.apiRunDeadline };
    return "Reopened.";
  };
  await harness.accept({ id: "api:run_26", source: "api", sessionKey: "api:issue-26", text: "Reopen SHR-26 and continue", replyTo: { channel: "api", target: "run_26" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && observed.previous === undefined; i++) await settle();
  assert.ok(observed.previous !== undefined, "API task had a run window");
  assert.equal(observed.deadline, observed.previous, "the rebound order task inherits the run deadline");
});

test("rebinding never extends an earlier task expiry through settlement", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-27 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let rebound = "";
  runtime.answer = async () => {
    const s = harness.state("api:issue-27"); const input = s.current!;
    await harness.operatorTaskDecision(ref.id, "reopen", "reopen-27", "Reopen SHR-27", "api:issue-27", input);
    rebound = input.taskId!;
    harness["tasks"](s).find((t: { id: string }) => t.id === rebound)!.expiresAt = 5_000; // already earlier
    await harness.operatorTaskDecision(ref.id, "clarify", "clarify-27", "Clarify SHR-27", "api:issue-27", input);
    return "Reopened.";
  };
  await harness.accept({ id: "api:run_27", source: "api", sessionKey: "api:issue-27", text: "Reopen SHR-27", replyTo: { channel: "api", target: "run_27" }, apiAcceptedAt: 1_000_000 });
  await harness.drained?.(); for (let i = 0; i < 60; i++) await settle();
  const task = harness["tasks"](harness.state("api:issue-27")).find((t: { id: string }) => t.id === rebound);
  assert.ok(task, "rebound task exists");
  assert.ok(task.expiresAt === undefined || task.expiresAt <= 5_000, `expiry never extended (got ${task.expiresAt})`);
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

test("work dispatched before a rebinding keeps the API run open and is revoked on its close", async t => {
  const { harness, runtime, runs, store, call, advance } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Original SHR-29 request", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let childId = "";
  runtime.answer = async () => {
    const s = harness.state("api:issue-29"); const input = s.current!;
    const child = await store.submit("api:issue-29", "req-29", "Update SHR-29", "direct", 1, harness.dependencyCheckpoint("api:issue-29"), undefined, harness.dispatchOrigin("api:issue-29"));
    childId = child.id; await store.claim(child.id); // dispatched BEFORE the rebinding, running
    await harness.operatorTaskDecision(ref.id, "reopen", "reopen-29", "Reopen SHR-29", "api:issue-29", input);
    return "Interim: worker dispatched, order reopened.";
  };
  await harness.sessionFor("api:issue-29");
  const { run_id } = await (await call("POST", "/v1/runs", { input: "Reopen SHR-29 and update it", session_id: "issue-29" })).json() as { run_id: string };
  for (let i = 0; i < 100 && !childId; i++) await settle();
  for (let i = 0; i < 30; i++) { await settle(); await harness.tick(); }
  assert.equal(runs.get(run_id)!.status, "running", "the original task's worker keeps the run open after rebinding");
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.notEqual(runs.get(run_id)!.status, "running");
  const row = store.list().find(e => e.id === childId)!;
  assert.equal(row.status, "cancelled", "the pre-rebinding worker is revoked when the run closes");
});

test("window close also aborts and drops follow-ups of tasks owned before a rebinding", async t => {
  const { harness, runtime, runs, start, advance } = await setup(t);
  const { run_id } = await start();
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiOwnedTasks = ["order:old:1"];
  s.tasks!.push({ id: "order:old:1", original: "Old order", state: "active", depth: 0, recoveryEnrollment: "current" });
  const session = runtime.sessions.get("api:issue-1")!; session.hold();
  await harness.accept({ id: "owned-running", source: "host", sessionKey: "api:issue-1", taskId: "order:old:1", text: "Owned follow-up" });
  await harness.accept({ id: "owned-queued", source: "host", sessionKey: "api:issue-1", taskId: "order:old:1", text: "Owned queued" });
  for (let i = 0; i < 50 && s.current?.id !== "owned-running"; i++) await settle();
  const running = s.current!;
  running.taskId = "order:old:1"; // a turn still bound to the pre-rebinding task
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.equal(s.cancelling === running || s.current !== running, true, "running owned follow-up aborted");
  assert.ok(!harness.pendingInputs().some(i => i.id === "owned-queued"), "queued owned follow-up dropped");
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

test("pre-rebinding ownership is retired when the run is released", async t => {
  const { harness, runs, store, start } = await setup(t);
  const { run_id, child } = await start();
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiOwnedTasks = ["order:old:1"];
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "done");
  for (const e of store.events().filter(e => e.executionId === child.id)) await store.ack(e.id);
  for (let i = 0; i < 100 && runs.get(run_id)!.status === "running"; i++) { await harness.tick(); await settle(); }
  assert.equal(runs.get(run_id)!.status, "completed");
  assert.equal(task.apiOwnedTasks, undefined, "a later run never adopts this run's ownership");
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

test("ownership is retired when the run's answer is delivered directly", async t => {
  const { harness, start, store } = await setup(t);
  const { child } = await start();
  const claim = await store.claim(child.id); await store.complete(child.id, claim.token!, "done");
  for (const e of store.events().filter(e => e.executionId === child.id)) await store.ack(e.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiHold = undefined; task.apiOwnedTasks = ["order:old:1"];
  assert.equal(harness["holdApiResult"](s, { id: "x", source: "api", sessionKey: "api:issue-1", taskId: task.id },
    { id: "direct", sessionKey: "api:issue-1", to: { channel: "api", target: "run_direct" }, text: "Done" }), false);
  assert.equal(task.apiOwnedTasks, undefined);
});

test("a pre-rebinding task's result resolves to the rebound owner and stays held while its work is live", async t => {
  const { harness, runs, store, start } = await setup(t);
  const { run_id, child } = await start();
  await store.claim(child.id); // rebound task's work is live
  const s = harness.state("api:issue-1"); const owner = harness["tasks"](s)[0];
  owner.apiOwnedTasks = ["order:old:1"];
  s.tasks!.push({ id: "order:old:1", original: "Old", state: "active", depth: 0, recoveryEnrollment: "current" });
  const held = harness["holdApiResult"](s, { id: "old-result", source: "host", sessionKey: "api:issue-1", taskId: "order:old:1" },
    { id: "old-answer", sessionKey: "api:issue-1", to: { channel: "api", target: run_id }, text: "Old child done" });
  assert.equal(held, true, "held by the rebound owner, not delivered");
  for (let i = 0; i < 10; i++) { await harness.tick(); await settle(); }
  assert.equal(runs.get(run_id)!.status, "running");
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

test("chained rebinding A -> B -> C transfers run ownership to C alone; a later run on A is unaffected", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const refs = [];
  for (const name of ["b", "c"]) { const r = await store.enrollTask(`room-${name}`, name, `Order ${name}`, "operator", "operator"); await store.decideTask(r, 1, "done", "close", "done"); refs.push(r); }
  let snapshot: Array<{ id: string; owned?: string[]; deadline?: number }> = []; let firstTask = "";
  runtime.answer = async () => {
    const s = harness.state("api:issue-31"); const input = s.current!;
    firstTask = input.taskId!;
    await harness.operatorTaskDecision(refs[0].id, "reopen", "reopen-b", "Reopen B", "api:issue-31", input);
    await harness.operatorTaskDecision(refs[1].id, "reopen", "reopen-c", "Reopen C", "api:issue-31", input);
    snapshot = harness["tasks"](s).map((t: { id: string; apiOwnedTasks?: string[]; apiRunDeadline?: number }) => ({ id: t.id, owned: t.apiOwnedTasks, deadline: t.apiRunDeadline }));
    return "Done.";
  };
  await harness.accept({ id: "api:run_31", source: "api", sessionKey: "api:issue-31", text: "Work", replyTo: { channel: "api", target: "run_31" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !snapshot.length; i++) await settle();
  const owners = snapshot.filter(t => t.owned?.includes(firstTask));
  assert.equal(owners.length, 1, `exactly one owner of A: ${JSON.stringify(snapshot)}`);
  assert.match(owners[0].id, /^order:/);
  assert.equal(snapshot.filter(t => t.deadline !== undefined).length, 1, "only the current owner carries the run window");
  assert.equal(owners[0].owned!.length, 2, "C owns both A and B");
  // After the run ended (answer delivered directly), ownership is retired: a later run on A resolves to A itself.
  assert.equal(harness["apiTaskFor"](harness.state("api:issue-31"), { id: "x", source: "host", sessionKey: "api:issue-31", taskId: firstTask }).id, firstTask);
});

test("rebinding is refused while the API run's revocation chain is in flight", async t => {
  const gates: Array<() => void> = [];
  const { harness, runtime, store, start } = await setup(t, { taskStopped: () => new Promise<void>(r => gates.push(r)) });
  t.after(() => { for (const g of gates) g(); });
  const { child } = await start(); await store.claim(child.id);
  const ref = await store.enrollTask("old-room", "old", "Order", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  (harness as unknown as { opts: { taskLifecycle?: { enabled: boolean } } }).opts.taskLifecycle = { enabled: true };
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  void harness["closeApiWindow"](s, task); await settle();
  const session = runtime.sessions.get("api:issue-1")!; session.hold();
  await harness.accept({ id: "follow-32", source: "api", sessionKey: "api:issue-1", text: "Reopen", replyTo: { channel: "api", target: "run_x" } });
  for (let i = 0; i < 50 && s.current?.id !== "follow-32"; i++) await settle();
  const origin = s.current!; origin.taskId = task.id;
  await assert.rejects(harness.operatorTaskDecision(ref.id, "reopen", "reopen-32", "Reopen", "api:issue-1", origin), /rebinding refused/);
  assert.equal(task.apiRevoking, true, "fence stays on the closing task");
  assert.equal(store.coreTask(ref.id)!.generation, ref.generation, "refusal writes nothing");
  // Drain the gated close before teardown removes the state directory.
  for (let i = 0; i < 200 && (gates.length || harness["apiClosings"].get(task)); i++) { gates.shift()?.(); await settle(); }
});

test("a window close starting during the rebinding's awaits keeps the fence and chain on the closing owner", async t => {
  const gates: Array<() => void> = [];
  const { harness, runtime, store, start } = await setup(t, { taskStopped: () => new Promise<void>(r => gates.push(r)) });
  t.after(() => { for (const g of gates) g(); });
  const { child } = await start(); await store.claim(child.id);
  const ref = await store.enrollTask("old-room", "old", "Order", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  (harness as unknown as { opts: { taskLifecycle?: { enabled: boolean } } }).opts.taskLifecycle = { enabled: true };
  const s = harness.state("api:issue-1"); const owner = harness["tasks"](s)[0];
  const session = runtime.sessions.get("api:issue-1")!; session.hold();
  await harness.accept({ id: "follow-33", source: "api", sessionKey: "api:issue-1", text: "Reopen", replyTo: { channel: "api", target: "run_y" } });
  for (let i = 0; i < 50 && s.current?.id !== "follow-33"; i++) await settle();
  const origin = s.current!; origin.taskId = owner.id;
  const bind = store.bindTask.bind(store);
  store.bindTask = (async (...a: Parameters<typeof store.bindTask>) => { owner.apiRevoking = true; harness["apiClosings"].set(owner, new Promise<void>(r => gates.push(r))); /* a stop's close begins during the await */ return bind(...a); }) as typeof store.bindTask;
  await harness.operatorTaskDecision(ref.id, "reopen", "reopen-33", "Reopen", "api:issue-1", origin);
  assert.equal(owner.apiRevoking, true, "fence stays on the closing owner");
  const others = harness["tasks"](s).filter((x: { id: string }) => x.id.startsWith("order:"));
  assert.equal(others.length, 1, "the rebound task exists");
  // Either the close already aborted the originating turn (nothing moves) or the rebound
  // task joins the closing owner; in no case does the run's ownership leave the owner.
  assert.equal(s.current, origin, "the stop's revocation is still pending; the turn is live");
  assert.ok(owner.apiOwnedTasks?.includes(others[0].id), "the rebound task joins the closing owner");
  for (const o of others) {
    assert.equal(o.apiRunDeadline, undefined, `window did not move to ${o.id}`);
    assert.equal(o.apiHold, undefined); assert.equal(o.apiRevoking, undefined);
  }
  assert.equal(harness["apiTaskFor"](s, origin).id, owner.id, "results resolve to the closing owner");
  harness["apiClosings"].delete(owner); owner.apiRevoking = undefined; for (const g of gates.splice(0)) g();
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(owner.apiRunDeadline !== undefined, true, "the closing owner keeps the window");
});

test("rebinding onto a task that already holds a run keeps the previous held answer in its deferred chain", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let result: { target?: string; hold?: string; deferred?: string[]; otherHold?: unknown; held?: string[] } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-34"); const input = s.current!;
    await harness.operatorTaskDecision(ref.id, "reopen", "reopen-34", "Reopen", "api:issue-34", input);
    const bound = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
    bound.apiHold = { deadline: 2_000_000, entry: { id: "bound-held", sessionKey: "api:issue-34", to: { channel: "api", target: "run_bound" }, text: "Bound" } };
    const other = { id: "other", original: "x", state: "active", depth: 0, recoveryEnrollment: "current", apiRunDeadline: 2_000_000,
      apiHold: { deadline: 2_000_000, entry: { id: "other-held", sessionKey: "api:issue-34", to: { channel: "api", target: "run_other" }, text: "Other" } } } as Record<string, unknown>;
    s.tasks!.push(other as never);
    input.taskId = "other";
    await harness.operatorTaskDecision(ref.id, "clarify", "clarify-34", "Clarify", "api:issue-34", input); // same generation: rebinds onto the holding task
    const target = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
    result = { target: target.id, hold: target.apiHold?.entry.id, deferred: target.apiDeferred?.map((e: { id: string }) => e.id), otherHold: other.apiHold, held: harness.heldApiRuns() };
    return "Done.";
  };
  await harness.accept({ id: "api:run_34", source: "api", sessionKey: "api:issue-34", text: "Work", replyTo: { channel: "api", target: "run_34" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !result; i++) await settle();
  assert.ok(result, "turn ran");
  assert.equal(result!.hold, "bound-held", JSON.stringify(result));
  assert.deepEqual(result!.deferred, ["other-held"], "the previous held answer is deferred, never dropped");
  assert.equal(result!.otherHold, undefined);
  assert.ok(result!.held!.includes("run_other"), "restart reconciliation still protects the previous run");
});

test("ownership joining during an in-flight revocation is revoked before the fence lifts", async t => {
  const stopped: string[] = []; const gates: Array<() => void> = [];
  const { harness, start, store } = await setup(t, { taskStopped: (_k: string, id: string) => { stopped.push(id); return new Promise<void>(r => gates.push(r)); } });
  const { child } = await start(); await store.claim(child.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  const closing = harness["closeApiWindow"](s, task);
  for (let i = 0; i < 20 && !gates.length; i++) await settle();
  task.apiOwnedTasks = [...(task.apiOwnedTasks ?? []), "order:joined:1"]; // a rebinding joins meanwhile
  for (let i = 0; i < 50 && task.apiRevoking; i++) { gates.shift()?.(); await settle(); }
  await closing;
  assert.ok(stopped.includes("order:joined:1"), `joined task revoked: ${stopped.join(",")}`);
  assert.equal(task.apiRevoking, undefined);
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

test("rebinding onto a holding task with a later deadline shortens its hold to the earlier window", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let result: { run?: number; hold?: number; prev?: number } | undefined;
  runtime.answer = async () => {
    const s = harness.state("api:issue-36"); const input = s.current!;
    await harness.operatorTaskDecision(ref.id, "reopen", "reopen-36", "Reopen", "api:issue-36", input);
    const bound = harness["tasks"](s).find((x: { id: string }) => x.id === input.taskId)!;
    bound.apiRunDeadline = 9_000_000;
    bound.apiHold = { deadline: 9_000_000, entry: { id: "bound-held", sessionKey: "api:issue-36", to: { channel: "api", target: "run_late" }, text: "Late" } };
    const early = { id: "early", original: "x", state: "active", depth: 0, recoveryEnrollment: "current", apiRunDeadline: 2_000_000 } as Record<string, unknown>;
    s.tasks!.push(early as never); input.taskId = "early";
    await harness.operatorTaskDecision(ref.id, "clarify", "clarify-36", "Clarify", "api:issue-36", input);
    result = { run: bound.apiRunDeadline, hold: bound.apiHold?.deadline, prev: 2_000_000 };
    return "Done.";
  };
  await harness.accept({ id: "api:run_36", source: "api", sessionKey: "api:issue-36", text: "Work", replyTo: { channel: "api", target: "run_36" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !result; i++) await settle();
  assert.ok(result, "turn ran");
  assert.equal(result!.run, 2_000_000);
  assert.equal(result!.hold, 2_000_000, "the hold never outlives the earlier window");
});

test("a hung turn rebound into a closing owner's ownership still expires with the owner's window", async t => {
  const { harness, runtime, call, advance } = await setup(t);
  await harness.sessionFor("api:issue-37");
  const session = runtime.sessions.get("api:issue-37")!; session.hold();
  await call("POST", "/v1/runs", { input: "Work SHR-37", session_id: "issue-37" });
  const s = harness.state("api:issue-37");
  for (let i = 0; i < 100 && !(s.running && s.current); i++) await settle();
  const owner = harness["tasks"](s).find((x: { id: string }) => x.id === s.current!.taskId)!;
  assert.ok(owner?.apiRunDeadline !== undefined, "API task has a run window");
  owner.apiOwnedTasks = ["order:joined:37"]; s.current!.taskId = "order:joined:37"; // rebound during a close
  advance(DEFAULT_API_RESULT_HOLD_MS + 1);
  const turn = s.current!;
  for (let i = 0; i < 30 && s.current === turn; i++) { await harness.tick(); await settle(); }
  assert.notEqual(s.current, turn, "expiry recognizes the owned task id and ends the hung turn");
  assert.equal(owner.termination, "deadline_expired");
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

test("window close stops the durable turns of owned queued follow-ups before dropping them", async t => {
  const stopped: string[] = [];
  const { harness, store, start } = await setup(t);
  const { child } = await start(); await store.claim(child.id);
  const stopTurn = store.stopTurn.bind(store);
  store.stopTurn = (async (id: string, key: string) => { stopped.push(id); return stopTurn(id, key).catch(() => undefined); }) as typeof store.stopTurn;
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  task.apiOwnedTasks = ["order:old:41"];
  const queued = { id: "owned-queued-41", source: "host" as const, sessionKey: "api:issue-1", text: "old follow-up", taskId: "order:old:41", executionTurnId: "turn-41" };
  s.queue.push(queued as never);
  await harness["closeApiWindow"](s, task);
  assert.ok(!s.queue.includes(queued as never), "dropped");
  assert.deepEqual(stopped.filter(x => x === "turn-41"), ["turn-41"], "its durable turn was stopped first");
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

test("a task has at most one owning run: rebinding onto a task owned by another run is refused before any write", async t => {
  const { harness, runtime, store } = await setup(t, { taskLifecycle: { enabled: true } });
  const ref = await store.enrollTask("old-room", "old", "Order", "operator", "operator");
  await store.decideTask(ref, 1, "done", "close", "done");
  let error = ""; let generation = 0;
  runtime.answer = async () => {
    const s = harness.state("api:issue-45"); const input = s.current!;
    s.tasks!.push({ id: "other-run-owner", original: "x", state: "active", depth: 0, recoveryEnrollment: "current", apiRunDeadline: 2_000_000, apiOwnedTasks: [`order:${ref.id}:1`] } as never);
    generation = store.coreTask(ref.id)!.generation;
    await harness.operatorTaskDecision(ref.id, "reopen", "reopen-45", "Reopen", "api:issue-45", input).catch(e => { error = String(e); });
    return "Done.";
  };
  await harness.accept({ id: "api:run_45", source: "api", sessionKey: "api:issue-45", text: "Work", replyTo: { channel: "api", target: "run_45" }, apiAcceptedAt: 1_000_000 });
  for (let i = 0; i < 2000 && !error; i++) await settle();
  assert.match(error, /owned by another API run/);
  assert.equal(store.coreTask(ref.id)!.generation, generation, "refusal writes nothing");
});

test("a child arriving for an already-revoked task during revocation is revoked before the fence lifts; no admission under the fence", async t => {
  const { harness, store, start } = await setup(t);
  const { child } = await start(); await store.claim(child.id);
  const s = harness.state("api:issue-1"); const task = harness["tasks"](s)[0];
  let late: { id: string } | undefined;
  const abortTurn = harness["abortTaskTurn"].bind(harness); // after the first revocation pass
  harness["abortTaskTurn"] = async (...a: unknown[]) => {
    const r = await abortTurn(...a);
    if (!late) { late = await store.submit("api:issue-1", "req-late", "Late child", "direct", 1, { taskId: task.id, depth: 1, original: task.original }); await store.claim(late.id); }
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
