import { testReviewExecution } from "./review-test-executor.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { git } from "../src/changeset.js";
import { reviewConfig } from "./review-test-config.js";
import { ReviewService } from "../src/builtin-plugins/review.js";
import { finishWithReview } from "../src/builtin-plugins/review-lifecycle.js";

async function fixture(t: TestContext) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "review-boundary-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "review-state-"));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await git(cwd, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(cwd, "a.ts"), "base\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "base"]);
  await git(home, ["init", "--bare", "remote.git"]);
  await git(cwd, ["remote", "add", "origin", path.join(home, "remote.git")]);
  await git(cwd, ["push", "-u", "origin", "HEAD:refs/heads/accepted"]);
  let calls = 0;
  const backend = { async review() { calls++; return '{"findings":[]}'; } };
  const config = reviewConfig({ baseRef: "origin/accepted" });
  const service = new ReviewService(home, config, backend, async () => {}, testReviewExecution(backend));
  await service.prepare(cwd);
  await writeFile(path.join(cwd, "a.ts"), "reviewed\n");
  await service.run(cwd, "task");
  const approved = await service.status(cwd);
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "reviewed task"]);
  return { cwd, home, service, approved, calls: () => calls, backend, config };
}

test("passed task starts at accepted upstream boundary without reviewing oversized historical changes", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "historical.ts"), "accepted upstream history\n".repeat(25000));
  await git(f.cwd, ["add", "."]);
  await git(f.cwd, ["commit", "-m", "upstream history"]);
  await git(f.cwd, ["push", "origin", "HEAD:refs/heads/accepted"]);
  const head = (await git(f.cwd, ["rev-parse", "HEAD"])).trim();
  const restarted = new ReviewService(f.home, f.config, f.backend, async () => {}, testReviewExecution(f.backend));
  await restarted.prepare(f.cwd);
  assert.equal(await finishWithReview(restarted, f.cwd, { sessionKey: "chat", source: "channel", text: "hello" }, "hello", {} as never, {}), "hello");
  assert.equal(f.calls(), 1);
  const state = await restarted.status(f.cwd);
  assert.equal(state.base, head);
  assert.equal(state.approvedFingerprint, undefined, "upstream acceptance is not local review approval");
  assert.equal(state.history?.at(-1)?.approvedFingerprint, f.approved.approvedFingerprint);
  assert.equal(state.history?.at(-1)?.base, f.approved.base);
  await writeFile(path.join(f.cwd, "a.ts"), "new unreviewed task\n");
  await assert.rejects(restarted.assertAllowed(f.cwd, "local"), /gate blocks/);
  await assert.rejects(restarted.assertAllowed(f.cwd, "publish"), /gate blocks/);
  await assert.rejects(restarted.assertAllowed(f.cwd, "merge"), /gate blocks/);
  await restarted.run(f.cwd, "new-task");
  assert.equal(f.calls(), 2);
  await restarted.assertAllowed(f.cwd, "publish");
});

test("prepare cannot discard dirty or unpushed task changes", async (t) => {
  const f = await fixture(t);
  await f.service.prepare(f.cwd);
  assert.equal((await f.service.status(f.cwd)).base, f.approved.base, "local committed work is not an upstream boundary");
  await writeFile(path.join(f.cwd, "a.ts"), "unreviewed edit\n");
  await git(f.cwd, ["push", "origin", "HEAD:refs/heads/accepted"]);
  await f.service.prepare(f.cwd);
  assert.equal((await f.service.status(f.cwd)).base, f.approved.base);
  await assert.rejects(f.service.assertAllowed(f.cwd, "publish"), /gate blocks/);
});

test("pending and escalated tasks never rotate their base at upstream movement", async (t) => {
  const f = await fixture(t);
  await f.service.requireOperator(f.cwd, "task", "hold");
  await git(f.cwd, ["push", "origin", "HEAD:refs/heads/accepted"]);
  await f.service.prepare(f.cwd);
  const state = await f.service.status(f.cwd);
  assert.equal(state.status, "escalated");
  assert.equal(state.base, f.approved.base);
  await assert.rejects(f.service.assertAllowed(f.cwd, "local"), /gate blocks/);
});

test("pending task cannot rotate even when current work becomes upstream", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "a.ts"), "unreviewed\n");
  const rejecting = new ReviewService(f.home, f.config, { async review() { return '{"findings":[{"id":"defect","severity":"P1","file":"a.ts","line":1,"title":"Defect","evidence":"Concrete failure"}]}'; } }, async () => {}, testReviewExecution({ async review() { return '{"findings":[{"id":"defect","severity":"P1","file":"a.ts","line":1,"title":"Defect","evidence":"Concrete failure"}]}'; } }));
  assert.equal((await rejecting.run(f.cwd, "task")).status, "pending");
  await git(f.cwd, ["add", "."]);
  await git(f.cwd, ["commit", "-m", "unreviewed task"]);
  await git(f.cwd, ["push", "origin", "HEAD:refs/heads/accepted"]);
  await rejecting.prepare(f.cwd);
  assert.equal((await rejecting.status(f.cwd)).base, f.approved.base);
  await assert.rejects(rejecting.assertAllowed(f.cwd, "merge"), /gate blocks/);
});

test("committed changes after prepare stay gated even if upstream later moves", async (t) => {
  const f = await fixture(t);
  await git(f.cwd, ["push", "origin", "HEAD:refs/heads/accepted"]);
  await f.service.prepare(f.cwd);
  await writeFile(path.join(f.cwd, "a.ts"), "current task\n");
  await git(f.cwd, ["add", "."]);
  await git(f.cwd, ["commit", "-m", "current task"]);
  await git(f.cwd, ["push", "origin", "HEAD:refs/heads/accepted"]);
  await assert.rejects(f.service.assertAllowed(f.cwd, "local"), /gate blocks/);
});

test("local target cannot turn unreviewed commits into a baseline", async (t) => {
  const f = await fixture(t);
  await git(f.cwd, ["branch", "accepted"]);
  const local = new ReviewService(f.home, reviewConfig({ baseRef: "accepted" }), f.backend, async () => {}, testReviewExecution(f.backend));
  await local.prepare(f.cwd);
  assert.equal((await local.status(f.cwd)).base, f.approved.base);
});

test("tracked oversized capture reports only safe error class, never source", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "a.ts"), "SECRET_SENTINEL_DO_NOT_ECHO\n".repeat(25000));
  try {
    await finishWithReview(f.service, f.cwd, { sessionKey: "chat", source: "channel", text: "hello" }, "hello", {} as never, {});
    assert.fail("capture must fail closed");
  } catch (error) {
    assert.match(String(error), /ERR_CHILD_PROCESS_STDIO_MAXBUFFER/);
    assert.doesNotMatch(String(error), /SECRET_SENTINEL/);
    assert.equal((error as Error).cause, undefined);
  }
});

test("failed changeset capture remains closed with safe root-cause diagnostics", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.cwd, "oversized.ts"), "x".repeat(530000));
  await assert.rejects(finishWithReview(f.service, f.cwd, { sessionKey: "chat", source: "channel", text: "hello" }, "hello", {} as never, {}), /Cannot establish review changeset.*size limit/);
});
