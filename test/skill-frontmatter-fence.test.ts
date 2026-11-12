import test from "node:test";
import assert from "node:assert/strict";
import { parseSkill } from "../src/skills.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const cases = [
  { label: "LF", close: "---\nBody", valid: true },
  { label: "CRLF", close: "---\r\nBody", valid: true },
  { label: "EOF", close: "---", valid: true },
  { label: "trailing spaces", close: "---  \nBody", valid: true },
  { label: "trailing tab", close: "---\t\r\nBody", valid: true },
  { label: "plain suffix", close: "---suffix\nBody", valid: false },
  { label: "four dashes", close: "----\nBody", valid: false },
  { label: "comment suffix", close: "--- # not a fence\nBody", valid: false },
  { label: "tab then suffix", close: "---\tsuffix\nBody", valid: false },
  { label: "missing fence", close: "Body", valid: false },
];
for (const { label, close, valid } of cases) {
  test(`skill frontmatter closing fence: ${label}`, () => {
    const skill = parseSkill(`---\nname: fixture\ndescription: A synthetic test skill\n${close}`, "/synthetic/fixture/SKILL.md");
    assert.equal(Boolean(skill), valid);
    if (valid) assert.equal(skill?.description, "A synthetic test skill");
  });
}

test("fully CRLF frontmatter is retained", () => {
  assert.equal(parseSkill("---\r\nname: fixture\r\ndescription: CRLF\r\n---\r\nBody", "/synthetic/fixture/SKILL.md")?.name, "fixture");
});

test("malformed fence stays excluded after catalog persistence and recreation", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-fence-catalog-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "skills");
  for (const [name, fence] of [["valid", "---"], ["malformed", "---suffix"]]) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic skill\n${fence}\nBody`);
  }
  const index = path.join(home, "index.json");
  const first = new SkillCatalog(index, () => [root]);
  await first.refresh();
  assert.deepEqual(first.skills.map(s => s.name), ["valid"]);
  const recreated = new SkillCatalog(index, () => [root]);
  await recreated.refresh();
  assert.deepEqual(recreated.skills.map(s => s.name), ["valid"]);
});
