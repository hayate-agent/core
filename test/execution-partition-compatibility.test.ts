import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore, executionRecoveryHash } from "../src/execution.js";
import { ExecutionDependencyStorage } from "../src/execution-dependency-storage.js";
import { PartitionedJson } from "../src/partitioned-json.js";

const arrays = { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 };
const dependency = { taskId: "original", depth: 2, original: "exact authority ".repeat(5000), retainedSnapshot: { stops: ["preserved"] } };
for (const format of ["deployed-v2", "previous-partition-v1"] as const) {
  test(`${format} migrates without losing exact dependencies, hashes, stops or idempotency`, async t => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "partition-compat-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "ledger.json"), source = new ExecutionStore(file);
    await source.load();
    const task = await source.submit("parent", "request", "authorized original", "direct", 1, dependency);
    await source.control(task.id, "pause");
    const ledger = { version: 1, executions: source.list(), events: source.events() };
    const expected = executionRecoveryHash(ledger.executions[0]!);
    if (format === "deployed-v2") {
      const executions = await new ExecutionDependencyStorage(file).stage(ledger.executions);
      await writeFile(file, JSON.stringify({ ...ledger, version: 2, executions }) + "\n", { mode: 0o600 });
    } else {
      await new PartitionedJson(file, arrays).save(ledger);
    }
    const exact = await readFile(file, "utf8");
    const cold = new ExecutionStore(file); await cold.load();
    assert.equal(executionRecoveryHash(cold.list()[0]!), expected);
    assert.equal((await cold.submit("parent", "request", "authorized original", "direct", 1, dependency)).id, task.id);
    await cold.ack("migration barrier");
    const suffix = format === "deployed-v2" ? "v2" : "partition-v1";
    assert.equal(await readFile(`${file}.legacy-${suffix}`, "utf8"), exact);
    assert.equal((await stat(`${file}.legacy-${suffix}`)).mode & 0o777, 0o600);
    const stored = await new PartitionedJson(file, arrays).load() as any;
    assert.equal(stored.version, 2);
    assert.equal(stored.executions[0].dependency, undefined);
    assert.ok(stored.executions[0].dependencyRef);
    const reopened = new ExecutionStore(file); await reopened.load();
    assert.equal(executionRecoveryHash(reopened.list()[0]!), expected);
    assert.deepEqual(reopened.list()[0]!.dependency, dependency);
    assert.equal(reopened.list()[0]!.status, "paused");
    assert.equal(reopened.events().length, ledger.events.length);
  });
}

test("missing committed partition directory fails closed instead of creating an empty execution store", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "partition-directory-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ledger.json"), store = new ExecutionStore(file);
  await store.load(); await store.submit("parent", "accepted", "retained authority", "direct");
  const manifest = await readFile(file, "utf8");
  await rm(file + ".parts", { recursive: true });
  const cold = new ExecutionStore(file);
  await assert.rejects(cold.load(), /partition directory/i);
  await assert.rejects(cold.ack("must not replace retained authority"), /not loaded/);
  assert.equal(await readFile(file, "utf8"), manifest);
});

test("immutable row deletion repairs on next barrier; corruption cannot be acknowledged", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "partition-rows-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "ledger.json"), store = new ExecutionStore(file); await store.load();
  await store.submit("parent", "request", "original", "direct", 1, dependency);
  const manifest = await readFile(file, "utf8");
  const name = (await readdir(file + ".parts"))[0]!;
  const row = path.join(file + ".parts", name), exact = await readFile(row);
  await rm(row); await store.ack("repair"); assert.deepEqual(await readFile(row), exact);
  await writeFile(row, "corrupt"); await assert.rejects(store.ack("barrier"), /checksum/);
  assert.equal(await readFile(file, "utf8"), manifest);
  await assert.rejects(new ExecutionStore(file).load(), /partition/i);
  await writeFile(row, exact); await chmod(row, 0o644);
  await assert.rejects(store.ack("unsafe permissions"), /[Pp]rivate|[Uu]nsafe/);
  await chmod(row, 0o600); await store.ack("safe repaired row");
  await rm(row); await symlink(file, row);
  await assert.rejects(store.ack("unsafe symlink"), /[Uu]nsafe/);
  assert.equal(await readFile(file, "utf8"), manifest);
});
