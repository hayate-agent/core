import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { SkillCatalog } from "../src/skill-catalog.js";

async function setup(t: TestContext) {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-catalog-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "skills");
  await mkdir(root);
  const index = path.join(root, "index.json");
  return { home, root, index, catalog: new SkillCatalog(index, () => [root]) };
}

async function skill(root: string, name: string, body = "body") {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await writeFile(file, `---\nname: ${name}\ndescription: Test ${name}\n---\n${body}`);
  return file;
}

test("catalog persists additions, body edits and deletions; no-op refresh is stable", async (t) => {
  const { root, index, catalog } = await setup(t);
  const empty = await catalog.refresh();
  const file = await skill(root, "search");
  const added = await catalog.refresh();
  assert.equal(added.generation, empty.generation + 1);
  assert.equal(added.entries[0].name, "search");
  assert.match(added.entries[0].contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(await catalog.refresh(), added);
  await skill(root, "search", "edit"); // same byte length; mtime is not authoritative
  await utimes(file, new Date(0), new Date(0));
  const edited = await catalog.refresh();
  assert.equal(edited.generation, added.generation + 1);
  assert.notEqual(edited.entries[0].contentHash, added.entries[0].contentHash);
  await rm(file);
  const deleted = await catalog.refresh();
  assert.equal(deleted.generation, edited.generation + 1);
  assert.deepEqual(deleted.entries, []);
  assert.deepEqual(JSON.parse(await readFile(index, "utf8")), deleted);
});

test("restart preserves generation, corrupt/missing cache is rebuilt from source", async (t) => {
  const { root, index, catalog } = await setup(t);
  await skill(root, "search");
  const first = await catalog.refresh();
  const restarted = new SkillCatalog(index, () => [root]);
  assert.deepEqual(await restarted.refresh(), first);
  await writeFile(index, "broken json");
  const rebuilt = await new SkillCatalog(index, () => [root]).refresh();
  assert.deepEqual(rebuilt.entries, first.entries);
  await rm(index);
  assert.deepEqual((await new SkillCatalog(index, () => [root]).refresh()).entries, first.entries);
});

test("invalid skills and collisions produce diagnostics; first root wins", async (t) => {
  const { home, root, index } = await setup(t);
  const second = path.join(home, "other");
  await skill(root, "search", "first");
  await skill(second, "search", "second");
  await skill(root, "bad--name");
  await mkdir(path.join(root, "invalid"));
  await writeFile(path.join(root, "invalid", "SKILL.md"), "---\ndescription: [broken\n---");
  const catalog = new SkillCatalog(index, () => [root, second, path.join(home, "missing")]);
  const snapshot = await catalog.refresh();
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].filePath, path.join(root, "search", "SKILL.md"));
  assert.equal(snapshot.diagnostics.length, 3);
  assert.match(snapshot.diagnostics.map((d) => d.message).join("\n"), /Duplicate skill name/);
});

test("symlinks cannot escape roots; loops terminate and internal aliases deduplicate", async (t) => {
  const { home, root, catalog } = await setup(t);
  const outside = path.join(home, "outside");
  await skill(outside, "secret");
  await skill(root, "safe");
  await symlink(outside, path.join(root, "escape"));
  await symlink(root, path.join(root, "loop"));
  await symlink(path.join(root, "safe"), path.join(root, "alias"));
  await mkdir(path.join(root, "file-escape"));
  await symlink(path.join(outside, "secret", "SKILL.md"), path.join(root, "file-escape", "SKILL.md"));
  const snapshot = await catalog.refresh();
  assert.deepEqual(snapshot.entries.map((s) => s.name), ["safe"]);
  assert.equal(snapshot.diagnostics.filter((d) => /escapes/.test(d.message)).length, 2);
});

test("untrusted cached paths never enter the catalog; concurrent refreshes serialize", async (t) => {
  const { root, index } = await setup(t);
  await writeFile(index, JSON.stringify({ schemaVersion: 1, generation: 10, roots: ["/etc"], entries: [{ name: "injected", filePath: "/etc/passwd" }] }));
  await skill(root, "safe");
  const catalog = new SkillCatalog(index, () => [root]);
  const results = await Promise.all(Array.from({ length: 8 }, () => catalog.refresh()));
  assert.ok(results.every((r) => r.generation === 11));
  assert.deepEqual(catalog.skills.map((s) => s.name), ["safe"]);
  results[0].entries.length = 0;
  assert.equal(catalog.skills.length, 1, "caller mutations do not alter catalog");
});
