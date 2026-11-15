import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile, symlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compactContext, contextArtifactDirectory } from "../src/context-artifacts.js";

const originalPath = (text: string) => /Complete original at (.*?); sha256=/.exec(text)![1]!;

test("long text becomes an honest excerpt with exact, private, session-bound retrievable details", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-artifacts-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = contextArtifactDirectory(home, "main", "run-1");
  const source = "BEGIN exact receipt\n" + "plain output 🙂\n".repeat(2000) + "ERROR actual failure\n" + "more output\n".repeat(2000) + "uncertain remote effect\nSTEP-STATUS: blocked: verify remote state";
  const excerpt = await compactContext(dir, source, "Worker report");
  assert(excerpt.length < 4000);
  assert.match(excerpt, /ERROR actual failure/);
  assert.match(excerpt, /STEP-STATUS: blocked/);
  assert.match(excerpt, /not a complete summary or proof of success/);
  const file = originalPath(excerpt);
  assert.equal(await readFile(file, "utf8"), source);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readFile(file.replace(/\.txt$/, ".lines.txt"), "utf8")).split("\n").join(""), source.replaceAll("\n", ""));
  assert.notEqual(dir, contextArtifactDirectory(home, "main", "run-2"));
  assert.notEqual(dir, contextArtifactDirectory(home, "worker", "run-1"));
  assert.equal(await compactContext(dir, "short exact ID: 123", "Tool"), "short exact ID: 123");
});

test("optional storage failure or redirected artifact directory never fails an operation or loses output", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-artifacts-failure-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const text = "effect receipt ".repeat(1000);
  const blocked = path.join(home, "blocked"); await writeFile(blocked, "not a directory");
  assert.equal(await compactContext(path.join(blocked, "run"), text, "Tool"), text);
  await symlink(home, path.join(home, "redirect"));
  assert.equal(await compactContext(path.join(home, "redirect", "run"), text, "Tool"), text);
});
