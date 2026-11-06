import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, symlink, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SkillUpdates } from "../src/skill-updates.js";
import { OverlayUpdater } from "../src/update.js";
const bundle = (name = "example") => Buffer.from(JSON.stringify({ version: 1, skills: [{ name, content: `---\nname: ${name}\ndescription: example\n---\nExample instructions` }] }));
const source = (bytes: Buffer) => ({ url: "https://example.invalid/skills.json", sha256: createHash("sha256").update(bytes).digest("hex") });
async function home(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skill-update-"));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
test("pinned download activates, preserves diagnostics and reconstructs on restart", async t => {
  const dir = await home(t), bytes = bundle();
  const updates = new SkillUpdates(dir, source(bytes), (async (_url, options) => {
    assert.equal(options?.redirect, "error"); assert.ok(options?.signal);
    return new Response(bytes);
  }) as typeof fetch);
  let result = { warnings: 0 };
  const updater = new OverlayUpdater(async () => {}, { skills: async () => {
    await updates.apply(async () => { result = { warnings: 2 }; }); return result;
  }, cron: async () => {} });
  assert.equal((await updater.run("apply", ["skills"]))[0].status, "activated-with-warnings");
  assert.match(await readFile(path.join(updates.roots[0], "example/SKILL.md"), "utf8"), /instructions/);
  const restored = new SkillUpdates(dir, source(bytes)); await restored.restore();
  assert.equal(restored.roots.length, 1); assert.notEqual(restored.roots[0], updates.roots[0]);
});
test("digest mismatch and traversal reject before activation", async t => {
  const dir = await home(t);
  for (const [bytes, pin] of [[bundle(), source(bundle("different"))], [bundle("../escape"), source(bundle("../escape"))]] as const) {
    const updates = new SkillUpdates(dir, pin, (async () => new Response(bytes)) as typeof fetch);
    await assert.rejects(updates.apply(async () => { throw Error("must not activate"); }), /integrity|entry/);
    assert.deepEqual(updates.roots, []);
  }
});
test("activation failure restores previous roots and persisted selection", async t => {
  const dir = await home(t), bytes = bundle();
  const updates = new SkillUpdates(dir, source(bytes), (async () => new Response(bytes)) as typeof fetch);
  await updates.apply(async () => {}); const previous = updates.roots;
  let calls = 0;
  await assert.rejects(updates.apply(async () => { if (++calls === 1) throw Error("activation failed"); }), /activation failed/);
  assert.equal(calls, 2); assert.deepEqual(updates.roots, previous);
  const restored = new SkillUpdates(dir, source(bytes)); await restored.restore(); assert.equal(restored.roots.length, 1);
});
test("oversized response and symlink destination fail closed", async t => {
  const dir = await home(t), bytes = bundle();
  const large = new SkillUpdates(dir, source(bytes), (async () => new Response(Buffer.alloc(524289))) as typeof fetch);
  await assert.rejects(large.apply(async () => {}), /too large/);
  const outside = path.join(dir, "outside"); await mkdir(outside); await symlink(outside, path.join(dir, "skill-updates"));
  const linked = new SkillUpdates(dir, source(bytes), (async () => new Response(bytes)) as typeof fetch);
  await assert.rejects(linked.apply(async () => {}), /Unsafe/);
});
