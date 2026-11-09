import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReviewEngine } from "../src/builtin-plugins/review-engine.js";
import { PluginHost } from "../src/plugins.js";
import { reviewConfig } from "./review-test-config.js";
import { testReviewExecution } from "./review-test-executor.js";
import { git } from "../src/changeset.js";

test("default shipped review adapter declares context support and reviews each actual repository, not startup cwd", async t => {
  assert.equal(createReviewEngine.executionContexts, 1);
  const home = await mkdtemp(path.join(os.tmpdir(), "default-review-context-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const roots = [path.join(home, "repo-a"), path.join(home, "repo-b")];
  for (const root of roots) {
    await mkdir(root); await git(root, ["init"]); await git(root, ["config", "user.name", "Fixture"]); await git(root, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(path.join(root, "code.ts"), "export const version = 1;\n"); await git(root, ["add", "."]); await git(root, ["commit", "-m", "Base"]);
    await writeFile(path.join(root, "code.ts"), "export const version = 2;\n");
  }
  const backend = { async review() { return '{"findings":[]}'; } };
  const engine = createReviewEngine({ home, cwd: home, cwdFor: key => roots[key === "a" ? 0 : 1]!,
    config: reviewConfig(), backend, reviewExecution: testReviewExecution(backend), async notify() {}, origin: () => undefined });
  const host = new PluginHost(); t.after(() => host.stop());
  await host.load([], { home, cwd: home, agent: "Fixture" }, [], [], engine.plugins);
  const tool = host.tools.get("plugin_review")!;
  await Promise.all(["a", "b"].map(sessionKey => tool.execute({ action: "run" }, { sessionKey })));
  for (const [index, sessionKey] of ["a", "b"].entries()) {
    const status = await tool.execute({ action: "status" }, { sessionKey });
    const summary = JSON.parse(status as string); assert.equal(summary.status, 'passed');
    const evidence = JSON.parse(await readFile(summary.evidence, 'utf8'));
    assert.equal(evidence.root, roots[index]);
  }
});
