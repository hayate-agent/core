import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { captureChangeset, git } from "../src/changeset.js";
import { reviewConfig } from "../src/review-config.js";
import { ReviewService } from "../src/review.js";

test("admin extension preserves history, persists and grants exactly two candidate-bound rounds", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "budget-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd);
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await git(cwd, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(cwd, "a.ts"), "base\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "base"]);
  await writeFile(path.join(cwd, "a.ts"), "candidate\n");
  let calls = 0;
  const config = reviewConfig({ maxTurns: 1 });
  const backend = { async review() { calls++; return JSON.stringify({ findings: [
    { id: "existing-p1", severity: "P1", file: "a.ts", line: 1, title: "Existing blocker", evidence: "Concrete evidence" },
  ] }); } };
  const create = () => new ReviewService(path.join(root, "home"), config, backend, async () => {});
  let service = create();
  const exhausted = await service.run(cwd, "work");
  assert.equal(exhausted.status, "escalated");
  const change = await captureChangeset(cwd, exhausted.base);
  const grant = { id: "operator-two-rounds", actor: "operator", reason: "Narrow review JSON repair only", base: change.base, fingerprint: change.fingerprint, rounds: 2 };
  await assert.rejects(service.extendBudget(cwd, { ...grant, rounds: 0 }), /Invalid/);
  await assert.rejects(service.extendBudget(cwd, { ...grant, fingerprint: "0".repeat(64) }), /exact current candidate/);
  const extended = await service.extendBudget(cwd, grant);
  assert.deepEqual(extended.rounds, exhausted.rounds);
  assert.equal(extended.approvedFingerprint, undefined);
  assert.equal(extended.status, "pending");
  await assert.rejects(service.assertAllowed(cwd, "publish"));
  service = create();
  assert.equal((await service.extendBudget(cwd, grant)).budgetGrants?.length, 1);
  await assert.rejects(service.extendBudget(cwd, { ...grant, rounds: 3 }), /already used/);
  await assert.rejects(service.run(cwd, "work"), /Critically assess/);
  await service.assess(cwd, change.fingerprint, [{ id: "existing-p1", disposition: "confirmed", evidence: "Still present" }]);
  assert.equal((await service.run(cwd, "work")).rounds.length, 2);
  await service.assess(cwd, change.fingerprint, [{ id: "existing-p1", disposition: "confirmed", evidence: "Still present" }]);
  assert.equal((await service.run(cwd, "work")).status, "escalated");
  await service.extendBudget(cwd, grant);
  await service.run(cwd, "work");
  assert.equal(calls, 3);
  const final = await service.status(cwd);
  assert.equal(final.rounds.length, 3);
  assert.deepEqual(final.rounds[0].findings, exhausted.rounds[0].findings);
  assert.deepEqual(final.rounds[0].assessment, [{ id: "existing-p1", disposition: "confirmed", evidence: "Still present" }]);
  assert.equal(final.budgetGrants?.[0].afterRound, 1);

  // An unconsumed extension must not become a generic budget increase.
  await service.extendBudget(cwd, { ...grant, id: "second-grant" });
  await writeFile(path.join(cwd, "a.ts"), "different candidate\n");
  assert.equal((await service.run(cwd, "work")).status, "escalated");
  assert.equal(calls, 3);
});
