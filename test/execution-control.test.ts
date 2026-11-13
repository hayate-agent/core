import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, lstat, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import os from "node:os";
import { ExecutionStore, ExecutionDecisionConflict } from "../src/execution.js";
import { executionControlRequest, executionControlPlugin } from "../src/execution-control.js";
import type { Dispatcher } from "../src/dispatcher.js";
import type { PluginAPI } from "../src/plugins.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "host-execution-control-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ExecutionStore(path.join(dir, "executions.json")); await store.load();
  const task = await store.submit("matrix:original-parent", "sole-owner", "Original authorized discovery; no side effects without permission", "sequential");
  const dispatcher = { store, consolidateDecisions: (parent: string, id: string, requestId: string, text: string, replaces: string[], followUp: import("../src/execution.js").ExecutionFollowUp | undefined, revision: number) => store.consolidateDecisions(parent, id, requestId, text, replaces, undefined, followUp, revision), decide: (parent: string, id: string, requestId: string, text: string, revision: number) => store.recordDecision(parent, id, requestId, text, undefined, revision) } as unknown as Dispatcher;
  const frame = { op: "decide", parent: task.parent, id: task.id, expectedRevision: 0, requestId: "operator-current-evidence-v1", text: "Source phase complete; continue original authorized read-only discovery. No repeated effects, new writer or permission expansion." };
  return { dir, store, task, dispatcher, frame };
}

test("native owner steers exact existing execution without a replacement writer or inference-API privilege", async t => {
  const f = await fixture(t);
  const first = await executionControlRequest(f.dispatcher, f.frame) as { replayed: boolean; executionStarted: boolean };
  assert.equal(first.replayed, false); assert.equal(first.executionStarted, false);
  assert.equal(f.store.list().length, 1); assert.equal(f.store.list()[0]!.id, f.task.id);
  assert.equal((await executionControlRequest(f.dispatcher, f.frame) as { replayed: boolean }).replayed, true);
  await assert.rejects(executionControlRequest(f.dispatcher, { ...f.frame, text: "different" }));
  await assert.rejects(executionControlRequest(f.dispatcher, { ...f.frame, parent: "different" }));
  await assert.rejects(executionControlRequest(f.dispatcher, { ...f.frame, requestId: "next", op: "resume" }));
  await assert.rejects(executionControlRequest(f.dispatcher, { ...f.frame, requestId: "next", followUp: { task: "new writer" } }));
  await assert.rejects(executionControlRequest(f.dispatcher, { ...f.frame, requestId: "stale" }));
});

for (const hold of ["manual-pause", "cancel", "question", "expired", "held-legacy"] as const) test(`native owner steering preserves ${hold}`, async t => {
  const f = await fixture(t);
  if (hold === "manual-pause") await f.store.control(f.task.id, "pause");
  if (hold === "cancel") await f.store.control(f.task.id, "cancel");
  if (hold === "question") { const c = await f.store.claim(f.task.id); await f.store.ask(f.task.id, c.token!, "original approval required"); }
  if (hold === "expired" || hold === "held-legacy") {
    const original = f.store.list.bind(f.store);
    f.store.list = parent => original(parent).map(task => ({ ...task, ...(hold === "expired" ? { dependency: { taskId: "deadline", original: task.input, depth: 0, expiresAt: Date.now() - 1 } } : { recoveryEnrollment: "held-legacy" as const }) }));
  }
  await assert.rejects(executionControlRequest(f.dispatcher, f.frame));
  assert.equal(f.store.list()[0]!.decisions?.length ?? 0, 0);
});

test("explicit native consolidation preserves exact applied originals and queues only a same-owner typed follow-up", async t => {
  const f = await fixture(t); await executionControlRequest(f.dispatcher, f.frame);
  const claim = await f.store.claim(f.task.id); await f.store.applyDecisions(f.task.id, claim.token!);
  const followUp = { task: "finish same owned source delivery", role: "high", reason: "explicit remaining authorized repair", evidence: "normal reviewed merge and validation" };
  const frame = { ...f.frame, op: "consolidate", requestId: "complete-current-context", expectedRevision: 1, replaces: [f.frame.requestId], text: "Complete replacement context; original permissions and completed effects remain binding", followUp };
  const reply = await executionControlRequest(f.dispatcher, frame) as { decision: { revision: number } }; assert.equal(reply.decision.revision, 2);
  assert.equal(f.store.list().length, 1); assert.equal(f.store.list()[0]!.decisions!.length, 1);
  assert.equal((await f.store.readDecision(f.task.parent, f.task.id, f.frame.requestId))!.text, f.frame.text);
  assert.equal((await executionControlRequest(f.dispatcher, frame) as { replayed: boolean }).replayed, true);
  await assert.rejects(executionControlRequest(f.dispatcher, { ...frame, requestId: "retire-pending", expectedRevision: 2, replaces: [frame.requestId] }));
  await assert.rejects(executionControlRequest(f.dispatcher, { ...frame, followUp: { ...followUp, task: "changed" } }));
});

test("expected decision revision is checked inside the serialized store commit", async t => {
  const f = await fixture(t);
  await f.store.recordDecision(f.task.parent, f.task.id, "intervening", "Original restriction remains");
  await assert.rejects(f.store.recordDecision(f.task.parent, f.task.id, "stale", "stale update", undefined, 0), ExecutionDecisionConflict);
  assert.equal(f.store.list()[0]!.decisions!.length, 1);
});

test("native control socket is owner-private, tool-free and drains/unlinks on shutdown", async t => {
  const f = await fixture(t); let stop!: () => Promise<void>; let tools = 0;
  let available: Dispatcher | undefined;
  await executionControlPlugin(() => available, path.join(f.dir, "control")).activate({ onStop: fn => { stop = fn as () => Promise<void>; }, registerTool: () => { tools++; } } as unknown as PluginAPI);
  assert.equal(tools, 0);
  available = f.dispatcher; // Dispatcher is constructed after plugin activation.
  const pointer = JSON.parse(await readFile(path.join(f.dir, "control", "owner.json"), "utf8"));
  const endpoint = path.join(f.dir, "control", pointer.socket); assert.equal((await lstat(endpoint)).mode & 0o777, 0o600);
  const reply = await new Promise<string>((resolve, reject) => { const socket = createConnection(endpoint); let data = ""; socket.on("connect", () => socket.write(JSON.stringify(f.frame) + "\n")); socket.on("data", x => data += x); socket.on("end", () => resolve(data)); socket.on("error", reject); });
  assert.equal(JSON.parse(reply).ok, true); await stop(); await assert.rejects(lstat(endpoint), /ENOENT/);
});
