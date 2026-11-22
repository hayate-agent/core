import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillCatalog } from "../src/skill-catalog.js";
import { skillSearchPlugin } from "../src/skill-search-plugin.js";

async function catalogWith(t: any, dir: string, name: string, description: string): Promise<SkillCatalog> {
  const skillsDir = path.join(dir, ".pi", "skills");
  await mkdir(path.join(skillsDir, name), { recursive: true });
  await writeFile(path.join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nUse it.\n`);
  return new SkillCatalog(path.join(dir, "index.json"), () => [skillsDir]);
}

const api = (tools: Map<string, unknown>) => ({
  version: 1,
  agent: "test",
  home: "/tmp",
  cwd: "/tmp",
  registerCommand() {}, registerChannel() {}, registerSessionProvider() {}, registerMemoryProvider() {},
  registerMemoryOrchestrator() {}, registerCompaction() {}, registerPanel() {}, registerDispatcher() {},
  registerPolicy() { return () => {}; }, onStop() {},
  registerTool: (tool: unknown) => { tools.set((tool as any).name, tool); },
} as any);

test("plugin_skill_search matches skills by keyword and reports misses", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-search-")); t.after(() => rm(home, { recursive: true, force: true }));
  const catalog = await catalogWith(t, home, "web-search", "Search the web and fetch results with firecrawl/playwright");
  await catalog.refresh();
  const tools = new Map<string, unknown>();
  const module = skillSearchPlugin(catalog);
  assert.equal(module.apiVersion, 1);
  await module.activate(api(tools));
  const tool = tools.get("plugin_skill_search") as any;
  assert.ok(tool, "plugin_skill_search registered");
  const hit = await tool.execute({ query: "firecrawl" }, { sessionKey: "test:1" });
  assert.match(hit, /web-search/);
  assert.ok(hit.includes(path.join(home, '.pi', 'skills', 'web-search', 'SKILL.md')), 'search supplies the actual readable path');
  assert.match(hit, /automatic loading is not guaranteed/);
  const miss = await tool.execute({ query: "quantumfloristics" }, { sessionKey: "test:1" });
  assert.match(miss, /No matching skills/);
});

test("search discovers created and updated skills without a manual reload or restart", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-search-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const catalog = await catalogWith(t, home, "web-search", "Old description for browser");
  await catalog.refresh();
  const tools = new Map<string, unknown>(); await skillSearchPlugin(catalog).activate(api(tools));
  const tool = tools.get("plugin_skill_search") as any;
  const file = path.join(home, ".pi", "skills", "web-search", "SKILL.md");
  await writeFile(file, "---\nname: web-search\ndescription: Newly updated retrieval workflow\n---\nUpdated instructions.\n");
  assert.match(await tool.execute({ query: "retrieval" }), /web-search/);
  const added = path.join(home, ".pi", "skills", "new-skill"); await mkdir(added);
  await writeFile(path.join(added, "SKILL.md"), "---\nname: new-skill\ndescription: Newly created unique workflow\n---\nNew instructions.\n");
  assert.match(await tool.execute({ query: "unique workflow" }), /new-skill/);
  await rm(added, { recursive: true });
  assert.match(await tool.execute({ query: "unique workflow" }), /No matching skills/);
});

test("plugin_skill_search stays empty-safe when no skills exist", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-search-empty-")); t.after(() => rm(home, { recursive: true, force: true }));
  const catalog = new SkillCatalog(path.join(home, "index.json"), () => [path.join(home, "nothing")]);
  await catalog.refresh();
  const tools = new Map<string, unknown>();
  await skillSearchPlugin(catalog).activate(api(tools));
  const tool = tools.get("plugin_skill_search") as any;
  const out = await tool.execute({ query: "anything" }, { sessionKey: "test:1" });
  assert.match(out, /No matching skills/);
});
