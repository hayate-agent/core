import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExecutionStore } from "../src/execution.js";

async function home(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-book-reclaim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "executions.json");
}
const pages = async (file: string) => (await readdir(`${file}.task-book`)).filter(n => n.endsWith(".json")).length;

test("the home owner keeps only the committed task-book generation: pages do not grow per write", async t => {
  const file = await home(t);
  const store = new ExecutionStore(file, { reclaimTaskBookPages: true }); await store.load();
  const ref = await store.enrollTask("matrix:room", "t0", "Mandate", "t0", "operator");
  const baseline = await pages(file);
  for (let i = 1; i <= 40; i++) await store.enrollTask("matrix:room", `t${i}`, `Mandate ${i}`, `t${i}`, "operator");
  // 41 tasks => 1 task page + 1 binding page + root.
  assert.equal(await pages(file), 3, `bounded, not one generation per write (baseline ${baseline})`);
  const reloaded = new ExecutionStore(file); await reloaded.load();
  assert.equal(reloaded.coreTask(ref.id)!.original, "Mandate", "committed authority intact after reclaim");
});

test("startup sweeps orphans from earlier generations and crashed stages, never committed pages", async t => {
  const file = await home(t);
  const writer = new ExecutionStore(file); await writer.load();
  for (let i = 0; i < 10; i++) await writer.enrollTask("matrix:room", `t${i}`, `Mandate ${i}`, `t${i}`, "operator");
  await writeFile(path.join(`${file}.task-book`, `${"a".repeat(64)}.json`), "{}", { mode: 0o600 });
  assert.ok(await pages(file) > 10, "legacy writer leaked every generation");
  const owner = new ExecutionStore(file, { reclaimTaskBookPages: true }); await owner.load();
  assert.equal(await pages(file), 3);
  for (let i = 0; i < 10; i++) assert.equal(owner.coreTask((await owner.enrollTask("matrix:room", `t${i}`, `Mandate ${i}`, `t${i}`, "operator")).id)!.original, `Mandate ${i}`);
  const cold = new ExecutionStore(file); await cold.load();
});

test("a store that does not own the home never deletes pages", async t => {
  const file = await home(t);
  const store = new ExecutionStore(file); await store.load();
  for (let i = 0; i < 5; i++) await store.enrollTask("matrix:room", `t${i}`, `Mandate ${i}`, `t${i}`, "operator");
  assert.ok(await pages(file) >= 10);
});
