import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RunRegistry } from "../src/api/runs.js";
import { ApiChannel } from "../src/api/server.js";
import { Harness, NO_REPLY } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

// Built at runtime so no token-shaped literal sits in the source.
const KEY = ["test", "api", "key"].join("-");

test("update admission is authenticated, exclusive, validated and fences runs without records", async () => {
  const { base, call, close, runs } = await setup();
  try {
    for (const method of ["GET", "POST", "DELETE"]) {
      assert.equal((await fetch(`${base}/v1/update-admission`, { method })).status, 401);
    }
    assert.equal((await call("POST", "/v1/update-admission", { ttl_ms: 0 })).status, 400);
    const admitted = await call("POST", "/v1/update-admission", { ttl_ms: 1000 });
    assert.equal(admitted.status, 201);
    const lease = await admitted.json() as { lease_id: string; expires_at: number; status: string };
    assert.equal(lease.status, "admitted");
    assert.equal((await call("GET", "/v1/update-admission")).status, 200);
    assert.equal((await call("POST", "/v1/update-admission")).status, 409);
    const denied = await call("POST", "/v1/runs", { input: "retry me" }, { "Idempotency-Key": "fenced" });
    assert.equal(denied.status, 503);
    assert.equal(runs.byIdempotencyKey("fenced"), undefined);
    assert.equal((await call("DELETE", "/v1/update-admission", { lease_id: "wrong" })).status, 409);
    assert.equal((await call("DELETE", "/v1/update-admission", { lease_id: lease.lease_id })).status, 200);
    assert.equal((await call("POST", "/v1/runs", { input: "retry me" }, { "Idempotency-Key": "fenced" })).status, 202);
  } finally { await close(); }
});

test("API model lookup reserves admission before a run record exists", async () => {
  const { api, call, close } = await setup();
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  (api as unknown as { opts: { models: () => Promise<string[]> } }).opts.models = async () => {
    entered(); await gate; return ["gw/model-a"];
  };
  const submitting = call("POST", "/v1/runs", { input: "work", model: "gw/model-a" });
  try {
    await ready;
    const denied = await call("POST", "/v1/update-admission");
    assert.equal(denied.status, 409);
    assert.equal((await denied.json() as { status: string }).status, "busy");
    release();
    assert.equal((await submitting).status, 202);
  } finally { release(); await submitting; await close(); }
});

async function setup(answer?: (t: string, k: string) => string, extra: { maxSseBufferBytes?: number } = {}) {
  const runtime = new FakeRuntime(answer);
  const harness = new Harness({ runtime, tickMs: 60_000, busyMode: "queue", log: () => {} });
  const dir = await mkdtemp(path.join(tmpdir(), "api-"));
  const runs = new RunRegistry(path.join(dir, "runs.json"));
  const api = new ApiChannel({
    key: KEY,
    host: "127.0.0.1",
    port: 0,
    agent: "tom",
    runs,
    updateAdmission: harness,
    cancel: (k, id) => harness.cancel(k, id),
    models: async () => ["gw/model-a", "gw/model-b"],
    defaultModel: () => "gw/model-a",
    keepaliveMs: 50,
    log: () => {},
    ...extra,
  });
  harness.addChannel(api);
  harness.onStateChange = async () => {};
  await harness.start();
  const base = `http://127.0.0.1:${api.address!.port}`;
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const close = () => harness.stop(0);
  return { runtime, harness, runs, api, base, call, close };
}

test("dispatcher progress is SSE status, not API completion; actual final answer still owns the run", async () => {
  const { api, runs, close } = await setup();
  try {
    const record = runs.create({ session_key: "api:progress" }); runs.started(record.run_id);
    await api.send({ channel: "api", target: record.run_id }, "Worker started", { presentation: "progress" });
    assert.equal(runs.get(record.run_id)!.status, "running"); assert.equal(runs.get(record.run_id)!.output, undefined);
    const events = runs.subscribe(record.run_id, -1); assert.ok(events.replay.some(event => event.data.event === "status.updated")); events.unsubscribe();
    await api.send({ channel: "api", target: record.run_id }, "Actual parent answer");
    assert.equal(runs.get(record.run_id)!.status, "completed"); assert.equal(runs.get(record.run_id)!.output, "Actual parent answer");
    await api.send({ channel: "api", target: record.run_id }, "Late worker notice", { presentation: "progress" });
    assert.equal(runs.get(record.run_id)!.output, "Actual parent answer");
  } finally { await close(); }
});

test("API stop remains available after a dispatcher status notification", async () => {
  const { api, runtime, harness, call, runs, close } = await setup();
  try {
    await harness.sessionFor("api:progress-stop"); runtime.sessions.get("api:progress-stop")!.hold();
    const response = await call("POST", "/v1/runs", { input: "Wait for authorized work", session_id: "progress-stop" });
    const { run_id } = await response.json() as { run_id: string }; await new Promise(resolve => setImmediate(resolve));
    await api.send({ channel: "api", target: run_id }, "Dispatcher execution started", { presentation: "progress" });
    assert.equal(runs.get(run_id)!.status, "running"); assert.equal((await call("POST", `/v1/runs/${run_id}/stop`)).status, 200);
    await harness.drained(); assert.equal(runs.get(run_id)!.status, "cancelled");
  } finally { await close(); }
});

/** Read SSE frames until the stream ends; returns parsed data payloads (comments skipped). */
async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((frame) => frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n"))
    .filter(Boolean)
    .map((d) => JSON.parse(d) as Record<string, unknown>);
}

async function untilTerminal(call: (m: string, p: string) => Promise<Response>, runId: string) {
  for (let i = 0; i < 200; i++) {
    const s = (await (await call("GET", `/v1/runs/${runId}`)).json()) as Record<string, unknown>;
    if (["completed", "failed", "cancelled", "interrupted"].includes(String(s.status))) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("run did not finish");
}

test("health is public; everything else needs the bearer key", async () => {
  const { base, call, close } = await setup();
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const denied = await fetch(`${base}/v1/capabilities`, { headers: { Authorization: "Bearer wrong" } });
    assert.equal(denied.status, 401);
    assert.equal(((await denied.json()) as { error: { code: string } }).error.code, "invalid_api_key");
    const caps = (await (await call("GET", "/v1/capabilities")).json()) as { features: Record<string, unknown> };
    assert.equal(caps.features.execution_routing, true);
    const models = (await (await call("GET", "/v1/models")).json()) as { data: Array<{ id: string }> };
    assert.deepEqual(models.data.map((m) => m.id), ["gw/model-a", "gw/model-b", "model-a", "model-b"]);
    assert.equal((await call("GET", "/v1/nope")).status, 404);
  } finally {
    await close();
  }
});

test("run: 202, SSE deltas and terminal event, status with output, session from header", async () => {
  const { runtime, call, close } = await setup((t) => `done: ${t}`);
  try {
    const created = await call(
      "POST",
      "/v1/runs",
      { input: "wake up", instructions: "be terse", model: "gw/model-b", model_options: { reasoning: { enabled: true, effort: "xhigh" } } },
      { "Idempotency-Key": "paperclip-run-1", "X-Hermes-Session-Key": "paperclip:agent:tom" },
    );
    assert.equal(created.status, 202);
    assert.equal(created.headers.get("x-hermes-session-key"), "paperclip:agent:tom");
    const { run_id, replayed } = (await created.json()) as { run_id: string; replayed: boolean };
    assert.equal(replayed, false);
    const events = await readEvents(await call("GET", `/v1/runs/${run_id}/events`, undefined, { Accept: "text/event-stream" }));
    const names = events.map((e) => e.event);
    assert.ok(names.includes("message.delta"));
    assert.equal(names.at(-1), "run.completed");
    assert.equal(events.at(-1)!.output, "done: wake up");
    const status = await untilTerminal(call, run_id);
    assert.equal(status.status, "completed");
    assert.equal(status.session_id, "paperclip:agent:tom");
    const session = runtime.sessions.get("api:paperclip:agent:tom")!;
    assert.match(session.options[0].instructions!, /^be terse\n/);
    assert.match(session.options[0].instructions!, /20 consecutive stalled or unevidenced attempts/);
    assert.deepEqual(session.options[0], { ...session.options[0], model: "gw/model-b", thinking: "xhigh" });
  } finally {
    await close();
  }
});

test("idempotency: same key + payload replays the run, different payload conflicts", async () => {
  const { runtime, call, close } = await setup();
  try {
    const body = { input: "once" };
    const a = (await (await call("POST", "/v1/runs", body, { "Idempotency-Key": "k1" })).json()) as { run_id: string };
    const again = await call("POST", "/v1/runs", body, { "Idempotency-Key": "k1" });
    assert.equal(again.status, 202);
    assert.equal(again.headers.get("idempotency-replayed"), "true");
    assert.equal(((await again.json()) as { run_id: string }).run_id, a.run_id);
    const conflict = await call("POST", "/v1/runs", { input: "other" }, { "Idempotency-Key": "k1" });
    assert.equal(conflict.status, 409);
    await untilTerminal(call, a.run_id);
    assert.equal([...runtime.sessions.values()].reduce((n, s) => n + s.prompts.length, 0), 1);
  } finally {
    await close();
  }
});

test("NO_REPLY and slash input: the run still completes; API input is never a command", async () => {
  const { harness, call, close } = await setup((t) => (t.startsWith("/") ? `turn: ${t}` : NO_REPLY));
  let commands = 0;
  harness.commandHandler = async () => (commands++, true);
  try {
    const a = (await (await call("POST", "/v1/runs", { input: "anything?" })).json()) as { run_id: string };
    assert.equal((await untilTerminal(call, a.run_id)).output, "");
    const b = (await (await call("POST", "/v1/runs", { input: "/restart" })).json()) as { run_id: string };
    assert.equal((await untilTerminal(call, b.run_id)).output, "turn: /restart");
    assert.equal(commands, 0);
  } finally {
    await close();
  }
});

test("stop: running run ends cancelled; stopping a finished run is 409", async () => {
  const { runtime, harness, call, close } = await setup();
  try {
    await harness.sessionFor("api:s");
    runtime.sessions.get("api:s")!.hold();
    const { run_id } = (await (await call("POST", "/v1/runs", { input: "long", session_id: "s" })).json()) as { run_id: string };
    await new Promise((r) => setTimeout(r, 20));
    const stop = await call("POST", `/v1/runs/${run_id}/stop`);
    assert.equal(stop.status, 200);
    assert.equal(((await stop.json()) as { status: string }).status, "stopping");
    const s = await untilTerminal(call, run_id);
    assert.equal(s.status, "cancelled");
    assert.equal((await call("POST", `/v1/runs/${run_id}/stop`)).status, 409);
  } finally {
    await close();
  }
});

test("failure: runtime error ends the run failed with the error message", async () => {
  const { call, close } = await setup(() => {
    throw new Error("upstream 503");
  });
  try {
    const { run_id } = (await (await call("POST", "/v1/runs", { input: "x" })).json()) as { run_id: string };
    const s = await untilTerminal(call, run_id);
    assert.equal(s.status, "failed");
    assert.match(String(s.error), /upstream 503/);
  } finally {
    await close();
  }
});

test("validation: missing input, unknown model, bad effort, bad idempotency key, unknown run", async () => {
  const { call, close } = await setup();
  try {
    assert.equal((await call("POST", "/v1/runs", {})).status, 400);
    assert.equal((await call("POST", "/v1/runs", { input: "x", model: "nope/x" })).status, 400);
    assert.equal((await call("POST", "/v1/runs", { input: "x", model_options: { reasoning: { effort: "ludicrous" } } })).status, 400);
    assert.equal((await call("POST", "/v1/runs", { input: "x" }, { "Idempotency-Key": "a b" })).status, 400);
    assert.equal((await call("GET", "/v1/runs/run_missing")).status, 404);
    assert.equal((await call("GET", "/v1/runs/run_missing/events")).status, 404);
  } finally {
    await close();
  }
});

test("events: reconnect with Last-Event-ID replays only newer events", async () => {
  const { call, close } = await setup();
  try {
    const { run_id } = (await (await call("POST", "/v1/runs", { input: "x" })).json()) as { run_id: string };
    await untilTerminal(call, run_id);
    const all = await readEvents(await call("GET", `/v1/runs/${run_id}/events`));
    const seqs = all.map((e) => e.seq as number);
    const tail = await readEvents(await call("GET", `/v1/runs/${run_id}/events`, undefined, { "Last-Event-ID": String(seqs[0]) }));
    assert.deepEqual(tail.map((e) => e.seq), seqs.slice(1));
  } finally {
    await close();
  }
});

test("idempotency: a concurrent duplicate waits for the original's acceptance and shares its failure", async () => {
  const { harness, runs, call, close } = await setup();
  try {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const accept = harness.accept.bind(harness);
    harness.accept = async (input) => {
      if (++calls === 1) {
        await gate;
        throw new Error("disk full"); // the original's acceptance fails
      }
      return accept(input);
    };
    const first = call("POST", "/v1/runs", { input: "x" }, { "Idempotency-Key": "dup" });
    await new Promise((r) => setTimeout(r, 20));
    const second = call("POST", "/v1/runs", { input: "x" }, { "Idempotency-Key": "dup" });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 503);
    // The duplicate never got a 202 for the failed run: it was accepted as a fresh run.
    assert.equal(b.status, 202);
    const { run_id, replayed } = (await b.json()) as { run_id: string; replayed: boolean };
    assert.equal(replayed, false);
    assert.equal(runs.byIdempotencyKey("dup")!.run_id, run_id);
    assert.equal(calls, 2, "the duplicate waited and was then accepted on its own");
  } finally {
    await close();
  }
});

test("shutdown is not held open by a half-sent request", async () => {
  const { api, close } = await setup();
  const net = await import("node:net");
  const sock = net.connect(api.address!.port, "127.0.0.1");
  await new Promise((r) => sock.once("connect", r));
  sock.write(`POST /v1/runs HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${KEY}\r\nContent-Length: 1000\r\n\r\n{"input":`);
  await new Promise((r) => setTimeout(r, 20));
  const started = Date.now();
  await close();
  assert.ok(Date.now() - started < 2000);
  sock.destroy();
});

test("events: a client that does not read is disconnected once its buffer exceeds the limit", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60_000, busyMode: "queue", log: () => {} });
  const runs = new RunRegistry(path.join(await mkdtemp(path.join(tmpdir(), "api-")), "runs.json"));
  const logs: string[] = [];
  const api = new ApiChannel({ key: KEY, host: "127.0.0.1", port: 0, agent: "t", runs, cancel: async () => false, models: async () => [], maxSseBufferBytes: 64 * 1024, log: (m) => logs.push(m) });
  harness.addChannel(api);
  await harness.start();
  const run = runs.create({ session_key: "k" });
  await runs.save();
  const net = await import("node:net");
  const sock = net.connect(api.address!.port, "127.0.0.1");
  try {
    await new Promise((r) => sock.once("connect", r));
    sock.pause(); // never reads
    sock.write(`GET /v1/runs/${run.run_id}/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${KEY}\r\n\r\n`);
    await new Promise((r) => setTimeout(r, 30));
    const big = "x".repeat(16 * 1024);
    for (let i = 0; i < 500 && !logs.some((l) => l.includes("too slow")); i++) {
      runs.turnEvent(run.run_id, { type: "text", delta: big });
      if (i % 20 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    assert.ok(logs.some((l) => l.includes("too slow")), "slow client dropped");
  } finally {
    sock.destroy();
    await harness.stop(0);
  }
});

test("idempotency: with several waiters and failing acceptances, no request gets 202 for a failed run", async () => {
  const { harness, runs, call, close } = await setup();
  try {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const accept = harness.accept.bind(harness);
    harness.accept = async (input) => {
      const n = ++calls;
      if (n === 1) await gate;
      if (n <= 2) throw new Error(`disk full ${n}`);
      return accept(input);
    };
    const reqs = [call("POST", "/v1/runs", { input: "x" }, { "Idempotency-Key": "dup2" })];
    await new Promise((r) => setTimeout(r, 20));
    reqs.push(call("POST", "/v1/runs", { input: "x" }, { "Idempotency-Key": "dup2" }));
    reqs.push(call("POST", "/v1/runs", { input: "x" }, { "Idempotency-Key": "dup2" }));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(reqs);
    const ok = await Promise.all(results.filter((r) => r.status === 202).map((r) => r.json() as Promise<{ run_id: string }>));
    assert.equal(results.filter((r) => r.status === 503).length, 2);
    assert.equal(ok.length, 1);
    assert.equal(runs.byIdempotencyKey("dup2")!.run_id, ok[0]!.run_id);
  } finally {
    await close();
  }
});

test("idempotency: replay of an accepted run does not depend on the model still being available", async () => {
  const { call, close, api } = await setup();
  try {
    const body = { input: "x", model: "gw/model-b" };
    const a = (await (await call("POST", "/v1/runs", body, { "Idempotency-Key": "m1" })).json()) as { run_id: string };
    (api as unknown as { opts: { models: () => Promise<string[]> } }).opts.models = async () => ["gw/model-a"];
    const again = await call("POST", "/v1/runs", body, { "Idempotency-Key": "m1" });
    assert.equal(again.status, 202);
    assert.equal(((await again.json()) as { run_id: string }).run_id, a.run_id);
    assert.equal((await call("POST", "/v1/runs", body, { "Idempotency-Key": "m2" })).status, 400);
  } finally {
    await close();
  }
});

test("validation: inherited object keys are not reasoning efforts", async () => {
  const { call, close } = await setup();
  try {
    for (const effort of ["constructor", "__proto__", "toString"]) {
      assert.equal((await call("POST", "/v1/runs", { input: "x", model_options: { reasoning: { effort } } })).status, 400, effort);
    }
  } finally {
    await close();
  }
});

test("validation: an oversized body gets a readable 413", async () => {
  const { call, close } = await setup();
  try {
    const res = await call("POST", "/v1/runs", { input: "x".repeat(5 * 1024 * 1024) });
    assert.equal(res.status, 413);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, "body_too_large");
  } finally {
    await close();
  }
});

test("events: a final output larger than the SSE buffer limit reaches a reading client whole, also on replay", async () => {
  const big = "y".repeat(256 * 1024);
  const { call, close } = await setup(() => big, { maxSseBufferBytes: 16 * 1024 });
  try {
    const { run_id } = (await (await call("POST", "/v1/runs", { input: "x" })).json()) as { run_id: string };
    const live = await readEvents(await call("GET", `/v1/runs/${run_id}/events`));
    const done = live.find((e) => e.event === "run.completed")!;
    assert.equal(done.output, big);
    const again = await readEvents(await call("GET", `/v1/runs/${run_id}/events`, undefined, { "Last-Event-ID": String(Number(done.seq) - 1) }));
    assert.equal(again.find((e) => e.event === "run.completed")!.output, big);
  } finally {
    await close();
  }
});

test("events: a replay larger than the SSE buffer limit reaches a reading client completely", async () => {
  const chunk = "z".repeat(32 * 1024);
  const { runs, call, close } = await setup(undefined, { maxSseBufferBytes: 16 * 1024 });
  try {
    const run = runs.create({ session_key: "k" });
    await runs.save();
    runs.started(run.run_id);
    for (let i = 0; i < 40; i++) runs.turnEvent(run.run_id, { type: "text", delta: chunk });
    await runs.finish(run.run_id, "end");
    const events = await readEvents(await call("GET", `/v1/runs/${run.run_id}/events`));
    assert.equal(events.filter((e) => e.event === "message.delta").length, 40);
    assert.equal(events.at(-1)!.event, "run.completed");
  } finally {
    await close();
  }
});

test("events: a client leaving in the middle of a backpressured replay is released", async () => {
  const chunk = "z".repeat(64 * 1024);
  const { api, runs, close } = await setup(undefined, { maxSseBufferBytes: 16 * 1024 });
  try {
    const run = runs.create({ session_key: "k" });
    await runs.save();
    for (let i = 0; i < 100; i++) runs.turnEvent(run.run_id, { type: "text", delta: chunk });
    await runs.finish(run.run_id, "end");
    const net = await import("node:net");
    const sock = net.connect(api.address!.port, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.pause();
    sock.write(`GET /v1/runs/${run.run_id}/events HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${KEY}\r\n\r\n`);
    const sockets = (api as unknown as { sockets: Set<unknown> }).sockets;
    for (let i = 0; i < 100 && sockets.size === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(sockets.size, 1, "replay is waiting for drain");
    sock.destroy();
    for (let i = 0; i < 100 && sockets.size > 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(sockets.size, 0);
  } finally {
    await close();
  }
});

test("models: a bare id resolves to its unique provider/model; provider must match; ambiguous ids are not aliases", async () => {
  const { call, close, api, runtime } = await setup();
  try {
    (api as unknown as { opts: { models: () => Promise<string[]> } }).opts.models = async () => ["gw/model-a", "gw/model-b", "other/model-b"];
    const ids = ((await (await call("GET", "/v1/models")).json()) as { data: Array<{ id: string }> }).data.map((m) => m.id);
    assert.deepEqual(ids, ["gw/model-a", "gw/model-b", "model-a", "other/model-b"]);
    const ok = await call("POST", "/v1/runs", { input: "x", model: "model-a", provider: "custom:gw" });
    assert.equal(ok.status, 202);
    const { run_id } = (await ok.json()) as { run_id: string };
    await untilTerminal(call, run_id);
    assert.equal(runtime.sessions.get(`api:${run_id}`)!.options.at(-1)!.model, "gw/model-a");
    assert.equal((await call("POST", "/v1/runs", { input: "x", model: "model-b", provider: "other" })).status, 202);
    assert.equal((await call("POST", "/v1/runs", { input: "x", model: "model-b" })).status, 400, "ambiguous");
    const wrong = await call("POST", "/v1/runs", { input: "x", model: "model-a", provider: "other" });
    assert.equal(wrong.status, 400);
    assert.equal(((await wrong.json()) as { error: { code: string } }).error.code, "provider_mismatch");
    // Provider without model: checked against the default model (gw/model-a).
    assert.equal((await call("POST", "/v1/runs", { input: "x", provider: "gw" })).status, 202);
    assert.equal((await call("POST", "/v1/runs", { input: "x", provider: "other" })).status, 400);
  } finally {
    await close();
  }
});
