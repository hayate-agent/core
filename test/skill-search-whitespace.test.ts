import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillCatalog } from "../src/skill-catalog.js";
import { skillSearchPlugin } from "../src/skill-search-plugin.js";

const cases = [
  { label: "exact keyword", query: "firecrawl", hit: true },
  { label: "uppercase keyword", query: "FIRECRAWL", hit: true },
  { label: "leading space", query: " firecrawl", hit: true },
  { label: "trailing space", query: "firecrawl ", hit: true },
  { label: "tab padding", query: "\tfirecrawl\t", hit: true },
  { label: "newline padding", query: "\nfirecrawl\n", hit: true },
  { label: "name match", query: "web-search", hit: true },
  { label: "description phrase preserved", query: "web and fetch", hit: true },
  { label: "unknown term", query: "quantumfloristics", hit: false },
  { label: "spaces only", query: "   ", hit: false },
  { label: "tabs only", query: "\t\t", hit: false },
  { label: "no implicit token AND", query: "firecrawl web", hit: false },
];

for (const { label, query, hit } of cases) {
  test(`skill query normalization: ${label}`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "skill-query-fixture-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const root = path.join(home, "skills");
    const skillDir = path.join(root, "web-search");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: web-search\ndescription: Search the web and fetch results with firecrawl/playwright\n---\nBODY_SENTINEL\n");
    const catalog = new SkillCatalog(path.join(home, "index.json"), () => [root]);
    await catalog.refresh();
    let tool: any;
    await skillSearchPlugin(catalog).activate({ registerTool(value: any) { tool = value; } } as any);
    const output = await tool.execute({ query });
    assert.equal(output.startsWith("Matching skills:"), hit, `query ${JSON.stringify(query)}`);
    assert.ok(!output.includes("BODY_SENTINEL"));
    assert.ok(!output.includes(home));
  });
}

test("normalized search preserves catalog order, limits, and metadata-only hits", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-query-limits-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, "skills");
  for (const name of ["alpha", "beta", "gamma"]) {
    await mkdir(path.join(root, name), { recursive: true });
    await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Shared keyword\n---\nBODY_SENTINEL\n`);
  }
  const catalog = new SkillCatalog(path.join(home, "index.json"), () => [root]);
  await catalog.refresh();
  let tool: any;
  await skillSearchPlugin(catalog).activate({ registerTool(value: any) { tool = value; } } as any);
  const parse = (output: string) => JSON.parse(output.slice(output.indexOf("["), output.lastIndexOf("]") + 1));
  const expected = catalog.skills.map(s => ({ name: s.name, description: s.description }));
  for (const limit of [1, 2, 20, 21]) {
    const hits = parse(await tool.execute({ query: "  SHARED  ", limit }));
    assert.deepEqual(hits, expected.slice(0, Math.min(limit, 20)));
  }
  assert.deepEqual(parse(await tool.execute({ query: "shared" })), expected);
  for (const query of ["", " ", "\t\n", "\u00a0"]) {
    assert.match(await tool.execute({ query }), /No matching skills/);
  }
});
