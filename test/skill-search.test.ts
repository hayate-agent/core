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
  assert.match(hit, /Read the named SKILL\.md/);
  const miss = await tool.execute({ query: "quantumfloristics" }, { sessionKey: "test:1" });
  assert.match(miss, /No matching skills/);
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
