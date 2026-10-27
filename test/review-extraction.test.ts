import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { git } from "../src/changeset.js";
import { ReviewService, type ReviewState } from "../src/builtin-plugins/review.js";
import { createReviewEngine } from "../src/builtin-plugins/review-engine.js";
import { reviewConfig } from "../src/review-config.js";
import { PluginHost } from "../src/plugins.js";

test("extracted engine reopens existing version1 ledger without resetting findings, grants, budget or bytes", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-extracted-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = path.join(home, "repo"); await mkdir(cwd);
  await git(cwd, ["init"]); await git(cwd, ["config", "user.name", "Test"]); await git(cwd, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(cwd, "a.ts"), "base\n"); await git(cwd, ["add", "."]); await git(cwd, ["commit", "-m", "base"]);
  const base = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  const ledger: ReviewState = { version: 1, root: cwd, base, status: "escalated", origin: { channel: "mem", target: "operator" },
    escalatedFor: "old-task", rounds: [{ fingerprint: "old-fingerprint", findings: [{ id: "p1", severity: "P1", file: "a.ts", line: 1, title: "retained", evidence: "proof" }],
      assessment: [{ id: "p1", disposition: "confirmed", evidence: "verified" }] }],
    budgetGrants: [{ id: "operator-grant", at: "2026-10-26T00:00:00Z", actor: "operator", reason: "scoped", base, fingerprint: "old-fingerprint", rounds: 2, afterRound: 1 }] };
  const file = path.join(home, "reviews", createHash("sha256").update(cwd).digest("hex") + ".json");
  await mkdir(path.dirname(file)); const bytes = JSON.stringify(ledger); await writeFile(file, bytes);
  let calls = 0;
  const backend = { async review() { calls++; throw Error("must not run"); } };
  const service = new ReviewService(home, reviewConfig({ maxTurns: 1 }), backend, async () => {});
  assert.deepEqual(await service.status(cwd), ledger);
  assert.equal(await readFile(file, "utf8"), bytes);
  assert.equal((await service.run(cwd, "other-task")).status, "escalated");
  assert.equal(calls, 0); assert.equal(await readFile(file, "utf8"), bytes);
  const engine = createReviewEngine({ home, cwd, config: reviewConfig(), backend, notify: async () => {}, origin: input => input.replyTo });
  const host = new PluginHost(); host.policies.require(engine.required);
  for (const policy of engine.policies) host.policies.register(policy);
  assert.throws(() => host.policies.remove("review"), /Required/);
  await host.load([], { home, cwd, agent: "test" }, [], [], engine.plugins);
  assert.ok(host.tools.has("plugin_review")); assert.ok(host.commands.has("review"));
  await host.stop();
});

test("disabled default composition registers no review policy or tools", () => {
  const engine = createReviewEngine({ home: "/tmp", cwd: "/tmp", config: reviewConfig({ enabled: false }),
    backend: { async review() { throw Error("disabled"); } }, notify: async () => {}, origin: () => undefined });
  assert.deepEqual(engine.required, []); assert.deepEqual(engine.policies, []); assert.deepEqual(engine.plugins, []); assert.equal(engine.instructions, "");
});
