import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { requestHash, RunRegistry, type RunEvent } from "../src/api/runs.js";

async function registry(now = () => 1_000_000) {
  const dir = await mkdtemp(path.join(tmpdir(), "runs-"));
  return new RunRegistry(path.join(dir, "runs.json"), { now });
}

test("requestHash is key-order independent", () => {
  assert.equal(requestHash({ a: 1, b: { c: 2, d: [1, 2] } }), requestHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
  assert.notEqual(requestHash({ a: 1 }), requestHash({ a: 2 }));
});

test("run lifecycle: events, usage, terminal result, status view", async () => {
  const reg = await registry();
  const r = reg.create({ session_key: "k", session_id: "sess", idempotency_key: "idem", body_hash: "h", model: "p/m" });
  await reg.save(); // as the API does before accepting the turn
  assert.equal(reg.byIdempotencyKey("idem"), r);
  const seen: Array<RunEvent | null> = [];
  const sub = reg.subscribe(r.run_id, -1, (e) => seen.push(e));
  assert.equal(sub.closed, false);
  reg.started(r.run_id);
  reg.turnEvent(r.run_id, { type: "text", delta: "Hel" });
  reg.turnEvent(r.run_id, { type: "tool", phase: "start", name: "bash" });
  reg.turnEvent(r.run_id, { type: "usage", model: "p/m", thinking: "low", input: 10, output: 5, cacheRead: 2, cacheWrite: 0, costUsd: 0.01 });
  reg.turnEvent(r.run_id, { type: "usage", model: "p/m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.01 });
  assert.equal(await reg.finish(r.run_id, "Hello"), true);
  assert.deepEqual(
    seen.map((e) => e && [e.seq, e.data.event]),
    [[0, "run.running"], [1, "message.delta"], [2, "tool.started"], [3, "usage.updated"], [4, "usage.updated"], [5, "run.completed"], null],
  );
  const terminal = seen[5]!.data;
  assert.equal(terminal.output, "Hello");
  assert.equal(terminal.completed, true);
  assert.deepEqual(terminal.execution_routing, { applied: true, model: "p/m", provider: "p", reasoning_effort: "low" });
  const view = reg.view(reg.get(r.run_id)!);
  assert.equal(view.object, "hermes.run");
  assert.equal(view.status, "completed");
  assert.equal(view.session_id, "sess");
  assert.equal(view.last_event, "run.completed");
  assert.deepEqual(view.usage, { input_tokens: 11, output_tokens: 6, cache_read_tokens: 2, cache_write_tokens: 0, model: "p/m" });
  // A finished run's events stay replayable; the stream is closed.
  const late = reg.subscribe(r.run_id, 3, () => assert.fail("no live events"));
  assert.deepEqual(late.replay.map((e) => e.seq), [4, 5]);
  assert.equal(late.closed, true);
});

test("failed and cancelled outcomes map to status and error", async () => {
  const reg = await registry();
  const a = reg.create({ session_key: "k" });
  await reg.finish(a.run_id, "⚠️ model down", "failed");
  assert.equal(reg.get(a.run_id)!.status, "failed");
  assert.equal(reg.view(reg.get(a.run_id)!).error, "model down");
  const b = reg.create({ session_key: "k" });
  await reg.finish(b.run_id, "", "cancelled");
  const v = reg.view(reg.get(b.run_id)!);
  assert.equal(v.status, "cancelled");
  assert.equal(v.interrupted, true);
  // A redelivered result does not change a finished run.
  await reg.finish(b.run_id, "late", undefined);
  assert.equal(reg.get(b.run_id)!.status, "cancelled");
  assert.equal(await reg.finish("run_unknown", "x"), false);
});

test("persisted: records survive a restart, sequence numbers never reused, lost runs interrupted", async () => {
  const reg = await registry();
  const done = reg.create({ session_key: "k", idempotency_key: "k1", body_hash: "h1" });
  await reg.finish(done.run_id, "ok");
  const pending = reg.create({ session_key: "k", idempotency_key: "k2" });
  const lost = reg.create({ session_key: "k" });
  reg.started(pending.run_id);
  reg.turnEvent(pending.run_id, { type: "text", delta: "x" });
  await reg.save();
  assert.equal((await stat(reg.file)).mode & 0o777, 0o600);

  const again = new RunRegistry(reg.file, { now: () => 1_000_000 });
  await again.load();
  assert.equal(again.byIdempotencyKey("k1")!.output, "ok");
  assert.equal(again.byIdempotencyKey("k2")!.run_id, pending.run_id);
  const interrupted = await again.reconcile((run) => run.input_id === pending.input_id);
  assert.deepEqual(interrupted, [lost.run_id]);
  assert.equal(again.get(lost.run_id)!.status, "interrupted");
  const lostSeq = again.get(lost.run_id)!.seq - 1;
  const ev = again.subscribe(lost.run_id, -1, () => assert.fail("closed"));
  assert.equal(ev.closed, true);
  assert.deepEqual(ev.replay.map((e) => [e.seq, e.data.event]), [[lostSeq, "run.interrupted"]]);
  const third = new RunRegistry(reg.file, { now: () => 1_000_000 });
  await third.load();
  assert.deepEqual(third.subscribe(lost.run_id, -1, () => {}).replay.map((e) => [e.seq, e.data.event]), [[lostSeq, "run.interrupted"]]);
  // Reconnect with the pre-restart Last-Event-ID: history is gone (truncated), new events get higher ids.
  const sub = again.subscribe(pending.run_id, 1, () => {});
  assert.ok(sub.truncated! > 1);
  again.turnEvent(pending.run_id, { type: "text", delta: "y" });
  const after = again.subscribe(pending.run_id, 1, () => {});
  assert.ok(after.replay[0]!.seq > 1);
  assert.match(await readFile(reg.file, "utf8"), /"version":1/);
});

test("terminal runs expire after the retention window; remove() frees the idempotency key", async () => {
  let now = 1_000_000;
  const reg = await registry(() => now);
  const r = reg.create({ session_key: "k", idempotency_key: "old" });
  await reg.finish(r.run_id, "ok");
  const open = reg.create({ session_key: "k", idempotency_key: "open" });
  now += 25 * 3600_000;
  // Expired without any intervening save: lookups already treat it as gone.
  assert.equal(reg.byIdempotencyKey("old"), undefined);
  assert.equal(reg.get(r.run_id), undefined);
  assert.equal(reg.byIdempotencyKey("old"), undefined);
  assert.ok(reg.get(open.run_id), "unfinished runs never expire");
  reg.remove(open.run_id);
  assert.equal(reg.byIdempotencyKey("open"), undefined);
});

test("sequence ids keep increasing across repeated crashes, even if the clock goes backwards", async () => {
  let now = 1_000_000;
  const reg = await registry(() => now);
  const r = reg.create({ session_key: "k" });
  await reg.save();
  const seen: number[] = [];
  for (let crash = 0; crash < 3; crash++) {
    now -= 60_000; // clock correction between crashes
    const next = new RunRegistry(reg.file, { now: () => now });
    await next.load();
    next.subscribe(r.run_id, -1, (e) => e && seen.push(e.seq));
    for (let i = 0; i < 3; i++) next.turnEvent(r.run_id, { type: "text", delta: "x" }); // crash: never saved
  }
  assert.equal(seen.length, 9);
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, "strictly increasing");
  // The terminal result after the last crash is above every id a client may have seen.
  const last = new RunRegistry(reg.file, { now: () => now });
  await last.load();
  const terminal: number[] = [];
  last.subscribe(r.run_id, -1, (e) => e && terminal.push(e.seq));
  await last.finish(r.run_id, "ok");
  assert.ok(terminal.at(-1)! > seen.at(-1)!);
});

test("terminal event survives a restart: replayed under its original id", async () => {
  const reg = await registry();
  const r = reg.create({ session_key: "k" });
  await reg.save();
  reg.started(r.run_id);
  reg.turnEvent(r.run_id, { type: "text", delta: "a" });
  const before: number[] = [];
  reg.subscribe(r.run_id, -1, (e) => e && before.push(e.seq));
  await reg.finish(r.run_id, "done");
  const terminalSeq = before.at(-1)!;
  const again = new RunRegistry(reg.file, { now: () => 1_000_000 });
  await again.load();
  const sub = again.subscribe(r.run_id, terminalSeq - 1, () => assert.fail("closed"));
  assert.equal(sub.closed, true);
  assert.equal(sub.truncated, undefined);
  assert.deepEqual(sub.replay.map((e) => [e.seq, e.data.event, e.data.output]), [[terminalSeq, "run.completed", "done"]]);
  // Older cursor: the progress events are gone (truncated), the terminal event still comes.
  const old = again.subscribe(r.run_id, -1, () => {});
  assert.equal(old.truncated, terminalSeq);
  assert.equal(old.replay.length, 1);
  assert.deepEqual(again.subscribe(r.run_id, terminalSeq, () => {}).replay, []);
});

test("finish freezes progress until the result is durable; live and replayed terminal ids match", async () => {
  const reg = await registry();
  const r = reg.create({ session_key: "k" });
  await reg.save();
  const live: Array<[number, string]> = [];
  reg.subscribe(r.run_id, -1, (e) => e && live.push([e.seq, String(e.data.event)]));
  reg.started(r.run_id);
  const done = reg.finish(r.run_id, "result");
  reg.turnEvent(r.run_id, { type: "text", delta: "late" }); // while the save is pending
  reg.turnEvent(r.run_id, { type: "usage", model: "p/m", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
  await done;
  assert.deepEqual(live.map(([, e]) => e), ["run.running", "run.completed"]);
  const again = new RunRegistry(reg.file, { now: () => 1_000_000 });
  await again.load();
  const replay = again.subscribe(r.run_id, live[0]![0], () => {}).replay;
  assert.deepEqual(replay.map((e) => [e.seq, e.data.event]), [live[1]]);
  assert.equal(again.get(r.run_id)!.usage, undefined);
});

test("reconcile: a run that never reached the inbox releases its idempotency key", async () => {
  const reg = await registry();
  const r = reg.create({ session_key: "k", idempotency_key: "idem", body_hash: "h" });
  await reg.save(); // then delivery failed and the cleanup write failed too; process restarts
  const again = new RunRegistry(reg.file, { now: () => 1_000_000 });
  await again.load();
  assert.deepEqual(await again.reconcile(() => false), [r.run_id]);
  assert.equal(again.byIdempotencyKey("idem"), undefined, "a retry starts a fresh run");
  assert.equal(again.get(r.run_id)!.status, "interrupted");
  const third = new RunRegistry(reg.file, { now: () => 1_000_000 });
  await third.load();
  assert.equal(third.byIdempotencyKey("idem"), undefined, "release is durable");
});
