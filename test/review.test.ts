import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { captureChangeset, git } from "../src/changeset.js";
import { reviewConfig } from "../src/review-config.js";
import { ReviewService, parseReview, type ReviewFinding } from "../src/review.js";
import { finishWithReview } from "../src/review-lifecycle.js";
import { guardReviewTool } from "../src/review-guard.js";
import { PluginHost } from "../src/plugins.js";
import { reviewPlugin } from "../src/review-plugin.js";

const finding: ReviewFinding = { id: "bug", severity: "P1", file: "a.ts", line: 1, title: "A defect", evidence: "Concrete failure" };
async function setup(t: TestContext, maxTurns = 3) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "review-repo-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "review-home-"));
  t.after(async () => { await rm(cwd, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.name", "Test"]);
  await git(cwd, ["config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(cwd, "a.ts"), "original\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-m", "base"]);
  const replies: string[] = [];
  const prompts: string[] = [];
  const escalations: string[] = [];
  let invoke: (() => Promise<void>) | undefined;
  const backend = { async review(prompt: string) { prompts.push(prompt); await invoke?.(); return replies.shift() ?? '{"findings":[]}'; } };
  const config = reviewConfig({ maxTurns });
  const service = new ReviewService(home, config, backend, async (_key, text) => { escalations.push(text); });
  await service.prepare(cwd);
  await writeFile(path.join(cwd, "a.ts"), "changed\n");
  return { cwd, home, service, config, backend, replies, prompts, escalations, onReview: (fn: () => Promise<void>) => { invoke = fn; } };
}

test("review defaults and invalid configuration", () => {
  assert.deepEqual(reviewConfig().mandatory, { local: true, publish: true, merge: true });
  assert.equal(reviewConfig().maxTurns, 3);
  assert.equal(reviewConfig().enabled, true);
  for (const value of [0, -1, 1.5, 21]) assert.throws(() => reviewConfig({ maxTurns: value }));
  assert.throws(() => reviewConfig({ model: "not-a-provider-ref" }));
  assert.throws(() => reviewConfig({ thinking: "invented" }));
});

test("reviewer output validates severity and paths", () => {
  assert.deepEqual(parseReview(JSON.stringify({ findings: [finding] })).findings, [finding]);
  assert.throws(() => parseReview(JSON.stringify({ findings: [{ ...finding, file: "../secret" }] })));
  assert.throws(() => parseReview(JSON.stringify({ findings: [{ ...finding, severity: "P9" }] })));
  assert.throws(() => parseReview(JSON.stringify({ findings: [finding, finding] })));
  assert.throws(() => parseReview("not JSON"));
});

test("changeset captures tracked and untracked files, excludes unrelated committed code", async (t) => {
  const { cwd } = await setup(t);
  await writeFile(path.join(cwd, "new.ts"), "new file body");
  const change = await captureChangeset(cwd, "HEAD");
  assert.match(change.diff, /changed/);
  assert.match(change.diff, /new file body/);
  assert.match(change.diff, /Untracked file "new.ts"/);
  const initial = change.fingerprint;
  await git(cwd, ["add", "."]);
  assert.notEqual((await captureChangeset(cwd, "HEAD")).fingerprint, initial);
});

test("P1 needs evidence-based assessment; three rounds persist and escalate without reset", async (t) => {
  const { cwd, home, service, config, backend, replies, escalations, prompts } = await setup(t);
  replies.push(...Array(3).fill(JSON.stringify({ findings: [finding] })));
  let state = await service.run(cwd, "work");
  assert.equal(state.status, "pending");
  await assert.rejects(service.run(cwd, "work"), /assess/);
  await assert.rejects(service.assess(cwd, state.rounds[0].fingerprint, [{ id: "bug", disposition: "false-positive", evidence: "" }]), /evidence/);
  for (let n = 1; n < 3; n++) {
    await service.assess(cwd, state.rounds.at(-1)!.fingerprint, [{ id: "bug", disposition: "false-positive", evidence: "Test proves the supposed failing path is guarded" }]);
    await writeFile(path.join(cwd, "a.ts"), `edit ${n}\n`);
    state = await service.run(cwd, "work");
  }
  assert.equal(state.status, "escalated");
  assert.equal(state.rounds.length, 3);
  assert.equal(escalations.length, 1);
  assert.match(prompts[1], /Test proves/);
  const restarted = new ReviewService(home, config, backend, async () => {});
  assert.equal((await restarted.run(cwd, "different-session")).rounds.length, 3);
  await assert.rejects(restarted.assertAllowed(cwd, "publish"), /gate blocks/);
});

test("P2/P3 pass, remain recorded, exact fingerprint required for publication", async (t) => {
  const { cwd, service, replies, prompts } = await setup(t);
  replies.push(JSON.stringify({ findings: [{ ...finding, severity: "P2" }] }));
  const state = await service.run(cwd, "work");
  assert.equal(state.status, "passed");
  assert.equal(state.rounds[0].findings?.length, 1);
  await service.assertAllowed(cwd, "publish");
  await service.run(cwd, "work");
  assert.equal(prompts.length, 1, "unchanged changeset reuses approval");
  await writeFile(path.join(cwd, "a.ts"), "new edit\n");
  await assert.rejects(service.assertAllowed(cwd, "merge"));
  const next = await service.run(cwd, "work");
  assert.equal(next.history?.[0].rounds[0].findings?.[0].severity, "P2", "old nonblocking findings remain archived");
});

test("invalid reviewer output consumes budget and fails closed", async (t) => {
  const { cwd, service, replies, escalations } = await setup(t, 1);
  replies.push("bad output");
  const state = await service.run(cwd, "work");
  assert.equal(state.status, "escalated");
  assert.ok(state.rounds[0].error);
  assert.equal(escalations.length, 1);
  await assert.rejects(service.assertAllowed(cwd, "local"));
});

test("concurrent source edits invalidate a clean reviewer result", async (t) => {
  const { cwd, service, onReview } = await setup(t, 1);
  onReview(() => writeFile(path.join(cwd, "a.ts"), "concurrent edit\n"));
  assert.equal((await service.run(cwd, "work")).status, "escalated");
});

test("corrupt state cannot reset budget", async (t) => {
  const { cwd, home, service } = await setup(t);
  const { readdir } = await import("node:fs/promises");
  const file = path.join(home, "reviews", (await readdir(path.join(home, "reviews")))[0]);
  await writeFile(file, "corrupt");
  await assert.rejects(service.run(cwd, "work"));
});

test("bundled plugin registers by default without a local module", async (t) => {
  const { cwd, home, service } = await setup(t);
  const host = new PluginHost();
  await host.load([], { cwd, home, agent: "test" }, [], [], [reviewPlugin(service, cwd)]);
  assert.ok(host.commands.has("review"));
  assert.ok(host.tools.has("plugin_review"));
  assert.equal(host.commands.get("review")?.admin, true);
  await host.stop();
});

test("shell guard blocks common publish/merge commands until review passed", async (t) => {
  const { cwd, service } = await setup(t);
  service.config.shellGuard = true;
  for (const command of ["git push origin HEAD", "git merge main", "gh pr create", "glab mr merge"]) {
    await assert.rejects(guardReviewTool(service, cwd, "bash", { command }));
  }
  await guardReviewTool(service, cwd, "bash", { command: "npm test" });
  await service.run(cwd, "work");
  await guardReviewTool(service, cwd, "bash", { command: "git push origin HEAD" });
});

test("lifecycle returns findings to working agent for critical assessment and correction", async (t) => {
  const { cwd, service, replies } = await setup(t);
  replies.push(JSON.stringify({ findings: [finding] }), '{"findings":[]}');
  const seen: string[] = [];
  const session = { async prompt(text: string) {
    seen.push(text);
    const state = await service.status(cwd);
    await service.assess(cwd, state.rounds.at(-1)!.fingerprint, [{ id: "bug", disposition: "confirmed", evidence: "Reproduced failure; fixed guard" }]);
    await writeFile(path.join(cwd, "a.ts"), "fixed\n");
    return "Fixed and tested";
  } };
  const result = await finishWithReview(service, cwd, { sessionKey: "work", source: "channel", text: "change" }, "done", session as never, {});
  assert.equal(result, "Fixed and tested");
  assert.equal(seen.length, 1);
  assert.equal((await service.status(cwd)).status, "passed");
});

test("a pre-aborted review does not consume a round", async (t) => {
  const { cwd, service, prompts } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.run(cwd, "work", controller.signal), /cancelled/);
  assert.equal((await service.status(cwd)).rounds.length, 0);
  assert.equal(prompts.length, 0);
});

test("shell guard is opt-in", async (t) => {
  const { cwd, service } = await setup(t);
  assert.equal(service.config.shellGuard, false);
  await guardReviewTool(service, cwd, "bash", { command: "git push" });
});

test("documentation-only edits skip automatic review, risky configuration does not", async (t) => {
  const { cwd, service, prompts } = await setup(t);
  await git(cwd, ["checkout", "--", "a.ts"]);
  await writeFile(path.join(cwd, "README.md"), "A spelling fix");
  assert.equal(await finishWithReview(service, cwd, { sessionKey: "work", source: "channel", text: "docs" }, "done", {} as never, {}), "done");
  assert.equal(prompts.length, 0);
  await service.assertAllowed(cwd, "merge");
  await writeFile(path.join(cwd, "package.json"), "{}");
  await assert.rejects(service.assertAllowed(cwd, "merge"));
});

test("escalation retains original channel and thread across restart", async (t) => {
  const { cwd, home, config, backend, replies } = await setup(t, 1);
  const origin = { channel: "matrix", target: "original-room", thread: "original-thread" };
  await new ReviewService(home, config, backend, async () => {}).prepare(cwd, origin, "original-session");
  let actual: unknown;
  const restarted = new ReviewService(home, config, backend, async (session, message, address) => { actual = { session, address }; });
  await restarted.prepare(cwd, { channel: "matrix", target: "other-room" }, "other-session");
  replies.push(JSON.stringify({ findings: [finding] }));
  await restarted.run(cwd, "other-session");
  assert.deepEqual(actual, { session: "original-session", address: origin });
});

test("disabled gate does not block", async (t) => {
  const { cwd, home, backend } = await setup(t);
  const service = new ReviewService(home, reviewConfig({ enabled: false }), backend, async () => {});
  await service.assertAllowed(cwd, "merge");
});
