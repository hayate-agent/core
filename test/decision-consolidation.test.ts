import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, rename, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore, executionDecisionRevision, ExecutionDecisionConflict } from "../src/execution.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "decision-consolidation-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "executions.json"), store = new ExecutionStore(file); await store.load();
  const task = await store.submit("parent", "request", "Original scope; no activation; reconcile all unknown effects", "sequential");
  return { file, store, task };
}

test("full active context has a supported durable consolidation path, not a larger terminal limit", async t => {
  const { file, store, task } = await fixture(t);
  let lastRevision = 0;
  for (let batch = 0; batch < 10; batch++) {
    for (let i = 0; i < 7; i++) await store.recordDecision("parent", task.id, `d-${batch}-${i}`, `Only scoped work, preserve original prohibition and unknown effects: ${"x".repeat(1800)}`);
    await assert.rejects(store.recordDecision("parent", task.id, "overflow", "x".repeat(3999)), /decision data limit/);
    const claim = await store.claim(task.id); await store.applyDecisions(task.id, claim.token!);
    const before = store.list()[0]!, ids = before.decisions!.map(d => d.requestId), original = before.decisions![0]!;
    const receipt = await store.consolidateDecisions("parent", task.id, `replacement-${batch}`, "Current scoped assignment only. Original no-activation constraint remains. Reconcile unknown effects; never replay.", ids);
    assert.ok(receipt.revision! > lastRevision); lastRevision = receipt.revision!;
    assert.equal(store.list()[0]!.token, claim.token, "active claim never stolen");
    await assert.rejects(store.fenceDecisions(task.id, claim.token!, executionDecisionRevision(before.decisions)), ExecutionDecisionConflict);
    assert.deepEqual(await store.readDecision("parent", task.id, original.requestId), original);
    assert.deepEqual(await store.recordDecision("parent", task.id, original.requestId, original.text), original, "archived idempotency prevents old instruction replay");
    await assert.rejects(store.recordDecision("parent", task.id, original.requestId, "different"), /Conflicting/);
    assert.deepEqual(await store.consolidateDecisions("parent", task.id, `replacement-${batch}`, receipt.text, ids), receipt);
    assert.equal(store.list()[0]!.input, task.input);
    await store.applyDecisions(task.id, claim.token!); await store.deferDecision(task.id, claim.token!);
    const restored = new ExecutionStore(file); await restored.load();
    assert.equal(executionDecisionRevision(restored.list()[0]!.decisions), lastRevision);
    assert.deepEqual(await restored.readDecision("parent", task.id, original.requestId), original);
    for (const event of store.events()) await store.ack(event.id);
  }
  assert.ok(lastRevision > 32, "lifetime steering revisions are not capped by active context size");
});

test("archive-before-commit crash preserves active context and exact idempotent recovery", async t => {
  const { file, store, task } = await fixture(t);
  await store.recordDecision("parent", task.id, "old", "No activation; retain previous effect receipts");
  const claim = await store.claim(task.id); await store.applyDecisions(task.id, claim.token!);
  await store.intent(task.id, claim.token!, "uncertain-effect", "unsafe", { model: "p/exact" }, 1);
  const before = store.list()[0]!;
  await rename(file, file + ".before"); await mkdir(file);
  await assert.rejects(store.consolidateDecisions("parent", task.id, "replacement", "Keep original scope and prohibition; reconcile unknown effects read-only", ["old"]));
  assert.deepEqual(store.list()[0]!, before, "failed commit does not retire active decisions or steal claim");
  await rm(file, { recursive: true }); await rename(file + ".before", file);
  const receipt = await store.consolidateDecisions("parent", task.id, "replacement", "Keep original scope and prohibition; reconcile unknown effects read-only", ["old"]);
  const after = store.list()[0]!;
  assert.deepEqual(after.intent, before.intent); assert.equal(after.token, before.token);
  assert.equal(receipt.revision, 2); assert.equal(after.input, before.input);
  assert.deepEqual(await store.readDecision("parent", task.id, "old"), before.decisions![0]);
  await assert.rejects(store.fenceDecisions(task.id, claim.token!, 1), ExecutionDecisionConflict);
});

for (const mode of ["foreign", "worker", "pending", "unknown", "cancelled", "manual-pause"] as const) test(`consolidation preserves ${mode} fence`, async t => {
  const { store, task } = await fixture(t); await store.recordDecision("parent", task.id, "old", "Original no-activation restriction");
  const claim = await store.claim(task.id);
  if (mode !== "pending") await store.applyDecisions(task.id, claim.token!);
  if (mode === "manual-pause") await store.control(task.id, "pause");
  if (mode === "cancelled") await store.control(task.id, "cancel");
  if (mode === "manual-pause") {
    const before = store.list()[0]!;
    await store.consolidateDecisions("parent", task.id, "new", "Preserve all original restrictions", ["old"], () => true);
    const after = store.list()[0]!; assert.equal(after.status, "paused"); assert.deepEqual(after.intent, before.intent);
  } else await assert.rejects(store.consolidateDecisions(mode === "foreign" ? "other" : mode === "worker" ? "dispatch:x" : "parent", task.id, "new", "Preserve restrictions", [mode === "unknown" ? "absent" : "old"], () => true));
});
