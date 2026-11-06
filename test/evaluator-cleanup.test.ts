import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { ExperimentEvaluator } from "../src/improvement-experiments.js";
const exec = promisify(execFile);

test("cleanup failure preserves evidence and attempts remaining worktrees", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp("/tmp/sample-cleanup-regression-");
  const oldPath = process.env.PATH;
  const git = async (...args: string[]) => (await exec("/usr/bin/git", ["-C", root, ...args])).stdout.trim();
  const worktrees = async () => (await git("worktree", "list", "--porcelain")).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9)).filter((p) => p !== root);
  try {
    await git("init"); await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
    await writeFile(root + "/score", "2"); await git("add", "score"); await git("commit", "-m", "baseline");
    const baseline = await git("rev-parse", "HEAD");
    await writeFile(root + "/score", "1"); await git("commit", "-am", "candidate");
    const candidate = await git("rev-parse", "HEAD");
    await mkdir(root + "/bin");
    await writeFile(root + "/bin/git", `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = remove ]; then
  case "$6" in */baseline) exit 73;; esac
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 });
    const source = `import {readFileSync} from 'node:fs';console.log(JSON.stringify({score:Number(readFileSync(process.argv[2]+'/score','utf8')),checksPassed:true}));`;
    await writeFile(root + "/runner.mjs", source);
    process.env.PATH = root + "/bin:" + (oldPath ?? "");
    const evaluator = new ExperimentEvaluator(root, root + "/evidence", root + "/runner.mjs", createHash("sha256").update(source).digest("hex"), 2000);
    const spec = { baseline, candidate, hypothesis: "preserve cleanup evidence", metric: "score", direction: "lower" as const, minimumDelta: 1 };
    const returned = await evaluator.evaluate(spec);
    const result = JSON.parse(await readFile(root + "/evidence/" + returned.id + ".json", "utf8"));
    assert.deepEqual(result, returned);
    assert.equal(result.verdict, "inconclusive");
    assert.equal(result.reason, "Experiment cleanup incomplete; operator recovery required");
    assert.equal(result.baseline.score, 2); assert.equal(result.candidate.score, 1);
    const leftovers = await worktrees();
    assert.equal(leftovers.length, 1); assert.ok(leftovers[0].endsWith("/baseline"));
    assert.deepEqual(result.cleanup.remainingWorktrees, leftovers);
    assert.equal(result.cleanup.complete, false);
    assert.equal(result.cleanup.retainedRoot, leftovers[0].slice(0, -"/baseline".length));
    process.env.PATH = oldPath;
    const next = await evaluator.evaluate(spec);
    assert.equal(next.verdict, "improved"); assert.equal(next.cleanup?.complete, true);
    for (const registered of [true, false]) {
      await writeFile(root + "/bin/git", `#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = add ]; then
  ${registered ? '/usr/bin/git "$@" || exit $?' : ':'}
  exit 73
fi
exec /usr/bin/git "$@"
`, { mode: 0o700 });
      process.env.PATH = root + "/bin:" + (oldPath ?? "");
      const partial = await evaluator.evaluate(spec);
      assert.equal(partial.verdict, "inconclusive");
      assert.equal(partial.cleanup?.complete, true, `cleanup after registration=${registered}`);
      assert.deepEqual(await worktrees(), leftovers, "no additional registration may survive failed add");
      process.env.PATH = oldPath;
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    for (const directory of await worktrees()) {
      await git("worktree", "remove", "--force", directory);
      await rm(directory.replace(/\/(baseline|candidate)$/, ""), { recursive: true, force: true });
    }
    await rm(root, { recursive: true, force: true });
  }
});
