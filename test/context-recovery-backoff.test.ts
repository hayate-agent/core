import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, contextPolicy, MaintenanceError } from "../src/context-maintenance.js";
import type { RuntimeSession } from "../src/types.js";

for (const entry of ["beforeTurn", "guidance", "prepared-old"] as const) test(`${entry}: failed prepared recovery has durable fixed backoff and remains fail closed`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "recovery-backoff-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let now = 10000, seeds = 0;
  const policy = () => contextPolicy();
  const old = { status: () => ({ sessionId: "old" }), archiveEntries: () => [], summarize: async () => "CURRENT STATE AND NEXT STEPS: preserve intent" } as unknown as RuntimeSession;
  const next = { status: () => ({ sessionId: "new" }), seedHandover: async () => { seeds++; throw new MaintenanceError("seed", "EIO"); } } as unknown as RuntimeSession;
  const create = () => new ContextMaintenance(home, policy, undefined, () => now);
  let maintenance = create();
  await maintenance.request("chat", { action: "handover", preserve: "correction", resume: "next bounded task" });
  maintenance.archives.link = async () => { throw new MaintenanceError("archive-link", "EIO"); };
  await maintenance.beforeTurn("chat", old, async () => next);
  const run = () => entry === "guidance" ? maintenance.guidance("chat", next) : entry === "prepared-old"
    ? maintenance.beforeTurn("chat", old, async () => { await next.seedHandover!(checkpointForSeed); return next; })
    : maintenance.beforeTurn("chat", next, async () => { throw Error("duplicate rotation"); });
  const checkpointForSeed = (await maintenance.status("chat")).handover!;
  now += 1000; // first failure was the archive-link attempt
  await run();
  assert.equal((await maintenance.recoveryStatus("chat"))?.state, "waiting");
  const failed = await maintenance.status("chat");
  const checkpoint = failed.handover;
  maintenance = create(); // restart must not reset the deadline or attempts
  for (let i = 0; i < 5; i++) {
    await run();
    assert.equal((await maintenance.recoveryStatus("chat"))?.state, "waiting");
  }
  assert.equal(seeds, 1, "rapid failed boundaries must not retry seed effects");
  assert.deepEqual((await maintenance.status("chat")).handover, checkpoint);
  assert.deepEqual((await maintenance.status("chat")).pending, failed.pending);
  now += 1999;
  await run();
  assert.equal(seeds, 1);
  now++;
  await run();
  assert.equal(seeds, 2);
  now += 3999;
  await run();
  assert.equal(seeds, 2, "second failure doubles delay without sliding on reads");
  now++;
  next.seedHandover = async () => { seeds++; };
  await run();
  const recovered = await maintenance.status("chat");
  assert.equal(seeds, 3);
  assert.equal(recovered.handover?.phase, "switched");
  assert.equal(recovered.pending, undefined);
  assert.equal(recovered.failure, undefined);
  assert.equal(recovered.recoveryRetry, undefined);
});
