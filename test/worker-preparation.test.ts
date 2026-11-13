import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/runtime/pi.js";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

async function home(t: { after(fn: () => unknown): void }) { const dir = await mkdtemp(path.join(os.tmpdir(), "worker-prepare-")); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }

test("first worker has persisted native evidence before model/MCP startup and before any intent; metadata is never a fake effect result", async t => {
  const dir = await home(t), sessionsDir = path.join(dir, "sessions"), key = "dispatch:owner:token";
  const runtime = new PiRuntime({ cwd: dir, sessionsDir } as never);
  await runtime.prepareWorkerEvidence(key, { executionId: "owner", task: "Original private authorized task" });
  const retained = await runtime.retainedSessionHistory(key); assert.ok(retained?.sessionFile);
  assert.match(JSON.stringify(retained.entries), /dispatcher-worker-preparation/);
  assert.match(JSON.stringify(retained.entries), /NOT proof of executed work/);
  assert.doesNotMatch(JSON.stringify(retained.entries), /Original private authorized task/);
  const before = await readFile(retained.sessionFile, "utf8");
  await runtime.prepareWorkerEvidence(key, { executionId: "owner", task: "Original private authorized task" });
  assert.equal(await readFile(retained.sessionFile, "utf8"), before);
  const manager = SessionManager.continueRecent(dir, path.dirname(retained.sessionFile));
  assert.equal(manager.getSessionId(), retained.sessionId);
  manager.appendMessage({ role: "user", content: "Execute first authorized bounded step", timestamp: Date.now() });
  assert.match(await readFile(retained.sessionFile, "utf8"), /Execute first authorized bounded step/);
  await assert.rejects(runtime.prepareWorkerEvidence("dispatch:foreign:token", { executionId: "owner", task: "scope" }));
});

test("failed durable worker preparation never leaves an opaque effect intent and remains automatically retryable", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prepare-fails-")), store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  let calls = 0;
  const dispatcher = new Dispatcher(store, { name: "fixture", version: 1, replaySafe: false, reconcile: true,
    prepareWorker: async () => { calls++; throw Error("metadata fsync failed"); },
    execute: async (_task, context) => { await context.intent("effect", "unsafe"); return "must never happen"; },
  }, 1, async () => {}, () => {});
  t.after(async () => { await dispatcher.stop(); await store.drain(); await rm(dir, { recursive: true, force: true }); });
  await dispatcher.start(); const row = await dispatcher.submit("parent", "one", "Original job");
  const deadline = Date.now() + 5000;
  while (!["paused", "blocked"].includes(store.list()[0]!.status) && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
  const failed = store.list()[0]!; assert.equal(failed.id, row.id); assert.equal(failed.status, "paused"); assert.equal(failed.intent, undefined);
  assert.equal(calls, 1); assert.ok(failed.workerRetry, "no fake uncertain effect that strands future retries");
});

test("recovery uses ONLY exact original intent-bound history when an old replacement was empty, and preserves newer-effect uncertainty", async () => {
  const runtime = new FakeRuntime(), reads: string[] = [];
  runtime.retainedSessionHistory = async key => { reads.push(key); return key === "dispatch:owner:original" ? { sessionId: "original-sdk", entries: [{ id: "receipt", role: "toolResult", text: "Known committed original effect" }] } : undefined; };
  const h = new Harness({ runtime, tickMs: 60000 }); const target = await h.sessionFor("dispatch:owner:replacement"); let seed = "";
  target.seedHandover = async text => { seed = text; };
  await h.reconcileSession("dispatch:owner:missing", "dispatch:owner:replacement", undefined, { executionId: "owner", sessionKey: "dispatch:owner:original" });
  assert.deepEqual(reads, ["dispatch:owner:missing", "dispatch:owner:original"]);
  assert.match(seed, /Known committed original effect/); assert.match(seed, /intermediate effects remain UNKNOWN/);
  assert.match(seed, /dispatch:owner:missing/); assert.equal(JSON.parse(seed).sourceKey, "dispatch:owner:original");
  await assert.rejects(h.reconcileSession("dispatch:owner:missing", "dispatch:owner:replacement", undefined, { executionId: "owner", sessionKey: "dispatch:foreign:original" }), /binding/);
});

test("missing original and replacement histories never become permission for a fresh worker", async () => {
  const runtime = new FakeRuntime(); runtime.retainedSessionHistory = async () => undefined;
  const h = new Harness({ runtime, tickMs: 60000 });
  await assert.rejects(h.reconcileSession("dispatch:owner:missing", "dispatch:owner:new", undefined, { executionId: "owner", sessionKey: "dispatch:owner:original" }), /evidence is empty/);
  assert.equal(runtime.sessions.size, 0);
});
