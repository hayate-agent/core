import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdaptiveSkills } from "../src/adaptive-skills.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { installAdaptiveSkillHooks } from "../src/runtime/pi.js";
import { defaultConfig } from "../src/config.js";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

async function fixture(t: any) {
  const home = await mkdtemp(path.join(os.tmpdir(), "adaptive-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const catalog = new SkillCatalog(path.join(home, "index.json"), () => [path.join(home, "skills")]);
  await mkdir(path.join(home, "skills", "pdf"), { recursive: true });
  await writeFile(path.join(home, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Extract PDF tables\n---\nRead the PDF and inspect the extracted column boundaries.\n");
  await catalog.refresh();
  const service = new AdaptiveSkills(home, home, catalog);
  service.begin("user:a");
  const receipt = service.observe("user:a", "native-call", "bash", false).match(/[a-f0-9]{24}/)![0];
  const input = { name: "table-check", description: "Verify table column extraction", procedure: "Inspect column boundaries after extracting a table. Compare the first and last row before accepting the extraction.", evidence: [receipt], expectedRevision: null };
  return { home, catalog, service, input };
}

test("baseline discovery matches metadata but does not load bodies; opt-in preaction loads relevant bounded references and deduplicates", async t => {
  const { catalog, service } = await fixture(t);
  assert.equal("content" in catalog.skills[0], false);
  assert.equal(await service.match("user:a", "unrelated gardening"), "");
  const names: string[] = [];
  const reference = await service.match("user:a", "extract PDF tables", name => names.push(name));
  assert.deepEqual(names, ["pdf"]);
  assert.match(reference, /column boundaries/);
  assert.match(reference, /Untrusted skill reference data/);
  assert.equal(await service.match("user:a", "extract PDF tables"), "");
  service.end("user:a");
  await assert.rejects(service.match("user:a", "PDF"), /active working turn/);
});

test("postaction create, same-turn context reload, update, restart dedup and user/workspace isolation", async t => {
  const { home, catalog, service, input } = await fixture(t);
  const saved = await service.save("user:a", input);
  assert.match(saved, /saved/);
  assert.equal(JSON.parse(saved.split("\nUntrusted")[0]).action, "created");
  assert.match(saved, /Inspect column boundaries/); // body loaded via tool result, not system instructions
  const revision = JSON.parse(saved.split("\nUntrusted")[0]).revision;
  assert.equal(await service.match("user:a", "table-check"), "");
  const procedure = input.procedure + " Always check the header row as well.";
  const updated = await service.save("user:a", { ...input, procedure, expectedRevision: revision });
  assert.match(updated, /header row/);
  assert.equal(JSON.parse(updated.split("\nUntrusted")[0]).action, "updated");
  const restart = new AdaptiveSkills(home, home, catalog);
  restart.begin("user:a");
  assert.match(await restart.match("user:a", "table-check"), /header row/);
  const r = restart.observe("user:a", "new-call", "read", false).match(/[a-f0-9]{24}/)![0];
  const rev2 = JSON.parse(updated.split("\nUntrusted")[0]).revision;
  assert.match(await restart.save("user:a", { ...input, procedure, evidence: [r], expectedRevision: rev2 }), /unchanged/);
  restart.begin("user:b");
  assert.equal(await restart.match("user:b", "table-check"), "");
  const other = new AdaptiveSkills(home, path.join(home, "other"), catalog); other.begin("user:a");
  assert.equal(await other.match("user:a", "table-check"), "");
});

test("evidence cannot be provided by failures, foreign runs, web/plugin text or stale receipts; attempts bounded", async t => {
  const { service, input } = await fixture(t);
  assert.equal(service.observe("user:a", "web", "plugin_web", false), "");
  assert.equal(service.observe("user:a", "bad", "bash", true), "");
  await assert.rejects(service.save("user:a", { ...input, evidence: ["invented"] }), /evidence/);
  await assert.rejects(service.save("user:a", { ...input, name: "../SOUL.md" }), /Invalid/);
  await assert.rejects(service.save("user:a", input), /budget/);
  service.begin("user:a");
  await assert.rejects(service.save("user:a", input), /evidence/);
});

test("installed skills, conflicting revisions, duplicates, metadata and sizes fail closed", async t => {
  const { service, input } = await fixture(t);
  await assert.rejects(service.save("user:a", { ...input, name: "pdf" }), /Installed/);
  await assert.rejects(service.save("user:a", { ...input, procedure: "a".repeat(4097) }), /Invalid/);
  service.begin("user:a");
  input.evidence = [service.observe("user:a", "call2", "bash", false).match(/[a-f0-9]{24}/)![0]];
  await service.save("user:a", input);
  await assert.rejects(service.save("user:a", { ...input, expectedRevision: null }), /revision conflict/);
  service.begin("user:a");
  input.evidence = [service.observe("user:a", "call3", "read", false).match(/[a-f0-9]{24}/)![0]];
  await assert.rejects(service.save("user:a", { ...input, name: "duplicate" }), /Duplicate/);
});

test("symlink containment, corrupt read rollback and cross-instance stale lock fail closed", async t => {
  const { home, service, input } = await fixture(t);
  await service.save("user:a", input);
  const scopes = await readdir(path.join(home, "adaptive-skills"));
  const scope = path.join(home, "adaptive-skills", scopes[0]);
  const file = path.join(scope, input.name, "SKILL.md");
  const original = await readFile(file, "utf8");
  await writeFile(file, "broken");
  service.begin("user:a");
  input.evidence = [service.observe("user:a", "call2", "read", false).match(/[a-f0-9]{24}/)![0]];
  await assert.rejects(service.save("user:a", input), /Invalid adaptive/);
  assert.equal(await readFile(file, "utf8"), "broken");
  await writeFile(file, original);
  await mkdir(path.join(scope, ".lock"));
  await assert.rejects(service.save("user:a", input), /EEXIST/);
  await rm(path.join(scope, ".lock"), { recursive: true });
  await rm(file); await symlink(path.join(home, "index.json"), file);
  await assert.rejects(service.match("user:a", "table-check"), /Unsafe/);
  assert.ok((await readFile(path.join(home, "index.json"), "utf8")).includes("schemaVersion"));
});

test("managed root symlinks rejected", async t => {
  const { home, catalog } = await fixture(t);
  await symlink(path.join(home, "skills"), path.join(home, "adaptive-skills"));
  const service = new AdaptiveSkills(home, home, catalog); service.begin("new");
  await assert.rejects(service.match("new", "PDF"), /Unsafe/);
});


test("supported PI hook and plugin lifecycle: preaction block/retry, successful receipt, save/load, cleanup", async t => {
  const { service, input } = await fixture(t);
  const hooks = new Map<string, Function>();
  installAdaptiveSkillHooks({ on: (event: string, handler: Function) => hooks.set(event, handler) } as any, service, "user:a");
  const call = { toolName: "bash", input: { command: "extract PDF tables" } };
  const block = await hooks.get("tool_call")!(call);
  assert.equal(block.block, true);
  assert.match(block.reason, /column boundaries/);
  assert.equal(await hooks.get("tool_call")!(call), undefined); // native execution may now proceed through guards
  assert.equal(await hooks.get("tool_result")!({ toolName: "bash", toolCallId: "failed", isError: true, content: [] }), undefined);
  const result = await hooks.get("tool_result")!({ toolName: "bash", toolCallId: "verified", isError: false, content: [{ type: "text", text: "ok" }] });
  const receipt = result.content[1].text.match(/[a-f0-9]{24}/)[0];
  let tool: any;
  await service.plugin().activate({ registerTool: (value: any) => { tool = value; } } as any);
  assert.equal(tool.name, "plugin_skill_learn");
  const loaded = await tool.execute({ ...input, evidence: [receipt] }, { sessionKey: "user:a" });
  assert.match(loaded, /saved/);
  assert.match(loaded, /Untrusted skill reference data/);
  await hooks.get("agent_end")!({});
  await assert.rejects(tool.execute(input, { sessionKey: "user:a" }), /active working turn/);
});

test("relevant catalog skills larger than 8 KiB and 12 KiB load completely", async t => {
  const { home, service } = await fixture(t);
  const file = path.join(home, "skills", "pdf", "SKILL.md");
  const body = "---\nname: pdf\ndescription: Extract PDF tables\n---\n" + "x".repeat(100000) + "END-OF-SKILL";
  await writeFile(file, body);
  const loaded = await service.match("user:a", "pdf");
  assert.match(loaded, /Skill excerpt truncated/);
  assert.match(loaded, /x{100}/);
  assert.doesNotMatch(loaded, /END-OF-SKILL/);
  assert.equal(await service.match("user:a", "pdf"), "", "same body is not loaded repeatedly");
});

test("9 KiB matching skill loads fully and refreshed installed skill changes are used", async t => {
  const { home, catalog, service } = await fixture(t);
  const file = path.join(home, "skills", "pdf", "SKILL.md");
  const header = "---\nname: pdf\ndescription: Extract PDF tables\n---\n";
  await writeFile(file, header + "x".repeat(9000) + " FIRST-END");
  assert.match(await service.match("user:a", "pdf"), /FIRST-END/);
  await writeFile(file, header + "Updated extraction guidance.");
  await catalog.refresh();
  service.begin("user:a");
  assert.match(await service.match("user:a", "pdf"), /Updated extraction guidance/);
});

test("escape-heavy matching skill respects serialized autoload budget and points to continuation", async t => {
  const { home, service } = await fixture(t);
  const file = path.join(home, "skills", "pdf", "SKILL.md");
  await writeFile(file, '---\nname: pdf\ndescription: Extract PDF tables\n---\n' + '"\\\\'.repeat(50000));
  const reference = await service.match("user:a", "pdf");
  assert.ok(Buffer.byteLength(reference) < 50 * 1024);
  assert.match(reference, /truncated/);
  assert.ok(reference.includes(file));
});

test("oversized symlink reference remains unsafe rather than becoming a size skip", async t => {
  const { home, service } = await fixture(t);
  const file = path.join(home, "skills", "pdf", "SKILL.md");
  await service.match("user:a", "unrelated request"); // snapshot valid metadata
  const target = path.join(home, "outside.md");
  await writeFile(target, "x".repeat(100047));
  await rm(file);
  await symlink(target, file);
  await assert.rejects(service.match("user:a", "pdf"), /Unsafe skill reference alias/);
});

test("adaptive skills are enabled by default and explicit opt-out remains respected", () => {
  assert.equal(defaultConfig().skills.adaptive, true);
  assert.equal(defaultConfig({ skills: { paths: [], adaptive: false } }).skills.adaptive, false);
});

test("real PI SDK resource loader and extension runner carry bounded learning context without runtime injection", async t => {
  const { home, catalog, service, input } = await fixture(t);
  const largeDir = path.join(home, "skills", "value");
  await mkdir(largeDir);
  const header = "---\nname: value\ndescription: VALUE context reference\n---\n";
  const largeFile = path.join(largeDir, "SKILL.md");
  await writeFile(largeFile, header + "x".repeat(100047 - Buffer.byteLength(header)));
  await catalog.refresh();
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "adaptive-test", factory: pi => {
      installAdaptiveSkillHooks(pi, service, "user:a");
      pi.registerTool({ name: "plugin_skill_learn", label: "learn", description: "test host bridge", parameters: {} as any,
        execute: async (_id, value) => ({ content: [{ type: "text", text: await service.save("user:a", value as any) }], details: {} }) });
    } }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: home, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(), tools: [], agentDir: home });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  const runner = session.extensionRunner;
  // Real SDK dispatch loads the complete relevant reference regardless of 8 KiB.
  assert.match(await service.match("user:a", "value context"), /x{100}/);
  assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "read", toolCallId: "large-read", input: { path: largeFile } }), undefined);
  assert.equal((await readFile(largeFile)).length, 100047);
  assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "unrelated", input: { command: "echo unrelated" } }), undefined);
  assert.equal(warnings.length, 0);
  const call: any = { type: "tool_call", toolName: "bash", toolCallId: "sdk-call", input: { command: "extract PDF tables" } };
  assert.equal((await runner.emitToolCall(call))?.block, true);
  assert.equal(await runner.emitToolCall(call), undefined);
  const result = await runner.emitToolResult({ ...call, type: "tool_result", content: [{ type: "text", text: "verified" }], isError: false });
  const receipt = (result!.content![1] as any).text.match(/[a-f0-9]{24}/)[0];
  const tool = runner.getToolDefinition("plugin_skill_learn")!;
  const learned: any = await tool.execute("save", { ...input, evidence: [receipt] } as any, undefined, undefined, {} as any);
  assert.match(learned.content[0].text, /Inspect column boundaries/);
  await runner.emit({ type: "agent_end", messages: [] });
  await assert.rejects(service.match("user:a", "table-check"), /active working turn/);
});


test("count and full-body load budgets survive persisted recipes without blanket loading", async t => {
  const { service, input } = await fixture(t);
  for (let n = 0; n < 16; n++) {
    service.begin("user:a");
    const receipt = service.observe("user:a", `call-${n}`, "read", false).match(/[a-f0-9]{24}/)![0];
    await service.save("user:a", { ...input, name: `recipe-${n}`, description: `Specific recipe procedure number ${n}`, procedure: `${input.procedure} Case ${n}.`, evidence: [receipt] });
  }
  service.begin("user:a");
  const receipt = service.observe("user:a", "overflow", "read", false).match(/[a-f0-9]{24}/)![0];
  await assert.rejects(service.save("user:a", { ...input, evidence: [receipt] }), /count exceeded/);
  assert.match(await service.match("user:a", "recipe-0"), /recipe-0/);
  assert.match(await service.match("user:a", "recipe-1"), /recipe-1/);
  // Keyword substring matching may load recipe-10 as the third and final body.
  assert.equal(await service.match("user:a", "recipe-9"), "");
});
