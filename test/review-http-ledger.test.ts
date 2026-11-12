import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { git } from "../src/changeset.js";
import { reviewConfig } from "./review-test-config.js";
import { ReviewService } from "../src/builtin-plugins/review.js";
import type { DedicatedReviewExecution } from "../src/builtin-plugins/review-executor.js";
const requested = { model: "fixture/first", thinking: "off" };
const defaults = { model: "fixture/default", thinking: "off" };
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-http-ledger-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "repo");
  await git(home, ["init", root]);
  await git(root, ["config", "user.name", "Test"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(root, "a.ts"), "before");
  await git(root, ["add", "."]); await git(root, ["commit", "-m", "base"]);
  const ledger = path.join(home, "reviews", createHash("sha256").update(root).digest("hex") + ".json");
  const service = (execution: DedicatedReviewExecution) => new ReviewService(home, reviewConfig(),
    { review: async () => { throw Error("general backend forbidden"); } }, async () => {}, execution);
  return { home, root, ledger, service };
}
for (const boundary of ["reservation", "initial", "fallback", "observed", "validated", "finalize"] as const) {
  for (const renamed of [false, true]) {
    test(`durable ${boundary} save failure renamed=${renamed} never replays`, async t => {
      const f = await fixture(t); let sends = 0; let handovers = 0;
      const service = f.service({ dispatcherEnabled: () => false,
        httpSelection: async () => ({ requested, defaults }),
        subagent: async request => {
          const a = request.httpAssessment!;
          await a.persist({ phase: "initial", actual: requested, executionId: "child" }); sends++;
          await a.persist({ phase: "fallback", actual: defaults, executionId: "child", initialRejected429: true }); sends++;
          await a.persist({ phase: "observed", actual: defaults, executionId: "child", result: '{"findings":[]}' });
          return { kind: "subagent", executionId: "child", isolated: true, fingerprint: request.fingerprint, result: '{"findings":[]}' };
        }, handoverWorktree: async () => { handovers++; throw Error("forbidden"); },
      });
      await service.prepare(f.root); await writeFile(path.join(f.root, "a.ts"), "after");
      const mutable = service as unknown as { save(state: any): Promise<void> };
      const save = mutable.save.bind(service);
      mutable.save = async state => {
        const a = state.rounds.at(-1)?.httpAssessment;
        const stage = state.rounds.at(-1)?.findings ? "finalize" : a?.executionValidated ? "validated" : a?.receipt?.phase ?? "reservation";
        if (a && stage === boundary) {
          if (renamed) await save(state);
          throw Error("injected durable save failure");
        }
        await save(state);
      };
      await assert.rejects(service.run(f.root, "parent"), /injected/);
      const before = sends;
      // A reservation which never reached disk has no committed round; all other
      // boundaries must resume without inference, including rename-then-error.
      if (boundary !== "reservation" || renamed) {
        const resumed = await f.service({ dispatcherEnabled: () => false,
          subagent: async () => { sends++; throw Error("replay"); },
        }).run(f.root, "parent");
        assert.equal(sends, before); assert.equal(handovers, 0);
        assert.equal(resumed.rounds.length, 1);
        assert.equal(resumed.status, boundary === "finalize" || (boundary === "validated" && renamed) ? "passed" : "pending");
      }
      assert.equal(before, ["observed", "validated", "finalize"].includes(boundary) ? 2 : boundary === "fallback" ? 1 : 0);
    });
  }
}
test("consumed unknown survives reload, blocks handover and another round", async t => {
  const f = await fixture(t);
  let sends = 0; let handovers = 0;
  const execution: DedicatedReviewExecution = {
    dispatcherEnabled: () => true, httpSelection: async () => ({ requested, defaults }),
    dispatcherWorker: async request => {
      await request.httpAssessment!.persist({ phase: "initial", actual: requested, executionId: "child" });
      sends++; throw Error("uncertain transport");
    }, handoverWorktree: async () => { handovers++; throw Error("must not execute"); },
  };
  const service = f.service(execution);
  await service.prepare(f.root); await writeFile(path.join(f.root, "a.ts"), "after");
  const first = await service.run(f.root, "parent");
  assert.equal(first.status, "pending"); assert.equal(first.rounds.length, 1);
  assert.equal(first.rounds[0].httpAssessment?.receipt?.phase, "initial");
  const next = await f.service(execution).run(f.root, "parent");
  assert.equal(next.rounds.length, 1); assert.equal(sends, 1); assert.equal(handovers, 0);
  await assert.rejects(f.service(execution).assertAllowed(f.root, "publish"));
});
test("closed HTTP result cannot bypass a mismatched execution receipt", async t => {
  const f = await fixture(t); let sends = 0;
  const execution: DedicatedReviewExecution = { dispatcherEnabled: () => false,
    httpSelection: async () => ({ requested, defaults }),
    subagent: async request => {
      sends++;
      await request.httpAssessment!.persist({ phase: "initial", actual: requested, executionId: "actual" });
      await request.httpAssessment!.persist({ phase: "observed", actual: requested, executionId: "actual", result: '{"findings":[]}' });
      return { kind: "subagent", isolated: true, fingerprint: request.fingerprint, executionId: "wrong", result: '{"findings":[]}' };
    },
  };
  const state = await f.service(execution).run(f.root, "parent");
  assert.notEqual(state.status, "passed"); assert.ok(state.rounds[0].error);
  const resumed = await f.service(execution).run(f.root, "parent");
  assert.notEqual(resumed.status, "passed"); assert.equal(sends, 1);
});
test("closed result reload finalizes existing round exactly once without inference", async t => {
  const f = await fixture(t);
  let sends = 0;
  const execution: DedicatedReviewExecution = {
    dispatcherEnabled: () => false, httpSelection: async () => ({ requested, defaults }),
    subagent: async request => {
      sends++;
      await request.httpAssessment!.persist({ phase: "initial", actual: requested, executionId: "child" });
      await request.httpAssessment!.persist({ phase: "observed", actual: requested, executionId: "child", result: '{"findings":[]}' });
      return { kind: "subagent", executionId: "child", isolated: true, fingerprint: request.fingerprint, result: '{"findings":[]}' };
    },
  };
  const service = f.service(execution);
  await service.prepare(f.root); await writeFile(path.join(f.root, "a.ts"), "after");
  await service.run(f.root, "parent");
  // Reconstruct precisely the persisted post-result/pre-findings crash boundary.
  const state = JSON.parse(await readFile(f.ledger, "utf8"));
  delete state.rounds[0].findings; delete state.approvedFingerprint; state.status = "pending";
  await writeFile(f.ledger, JSON.stringify(state));
  const resumed = await f.service(execution).run(f.root, "parent");
  assert.equal(resumed.status, "passed"); assert.equal(resumed.rounds.length, 1);
  assert.equal(resumed.rounds[0].httpAssessment.receipt.executionId, "child");
  assert.deepEqual(resumed.rounds[0].httpAssessment.requested, requested);
  await f.service(execution).run(f.root, "parent"); assert.equal(sends, 1);
});
