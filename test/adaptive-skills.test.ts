import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { skillSearchPlugin } from "../src/skill-search-plugin.js";
import { AdaptiveSkills, learningOwner } from "../src/adaptive-skills.js";
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
  assert.equal(hooks.has("agent_end"), false, "intermediate PI loop end must not end the working run");
  assert.equal(await hooks.get("tool_call")!({ toolName: "bash", input: { command: "echo continued" } }), undefined);
  await hooks.get("agent_settled")!({});
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
  assert.equal(await runner.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: "continued", input: { command: "echo continued" } }), undefined);
  await runner.emit({ type: "agent_settled", outcome: "completed" } as any);
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
  // Whole-word matching: recipe-9 is the exact third body; the budget then blocks a fourth.
  assert.match(await service.match("user:a", "recipe-9"), /recipe-9/);
  assert.equal(await service.match("user:a", "recipe-10"), "");
});

test("unrelated tool input does not trigger skill reference via substring or single weak description hit", async t => {
  const { home, catalog, service } = await fixture(t);
  await mkdir(path.join(home, "skills", "brainq"), { recursive: true });
  await writeFile(path.join(home, "skills", "brainq", "SKILL.md"), "---\nname: brain-query\ndescription: Search and synthesize knowledge across all vaults. Use when the user asks about a session or history.\n---\nBODY-BRAIN\n");
  await catalog.refresh();
  // "sessions"/"history" only substring/single-word overlap with the description, not a real topical match
  assert.equal(await service.match("user:a", "history archive summary sessions"), "");
  assert.equal(await service.match("user:a", "bash ls /tmp use when"), "");
  // genuine match: explicit full skill name
  assert.match(await service.match("user:a", "brain-query"), /BODY-BRAIN/);
});

test("single name words in pure diagnostics do not inject unrelated skills, explicit invocation still does", async t => {
  const { home, catalog, service } = await fixture(t);
  await mkdir(path.join(home, "skills", "bc"), { recursive: true });
  await writeFile(path.join(home, "skills", "bc", "SKILL.md"), "---\nname: fritz-brain-compile\ndescription: Promote raw captures into compiled knowledge articles for the service.\n---\nBODY-COMPILE\n");
  await catalog.refresh();
  for (const q of ["bash systemctl status brain service", "grep compile error src", "read brain.log service compile", "fritz"]) assert.equal(await service.match("user:a", q), "", q);
  assert.match(await service.match("user:a", "run fritz-brain-compile now"), /BODY-COMPILE/);
});

test("worker-learned recipes persist in the owning conversation scope and stay isolated from other conversations", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "adaptive-owner-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const catalog = new SkillCatalog(path.join(home, "index.json"), () => [path.join(home, "skills")]);
  await catalog.refresh();
  const parents: Record<string, string> = { "dispatch:exec1:tok": "matrix:!room", "subagent:s1": "dispatch:exec1:tok" };
  const owner = (key: string) => learningOwner(key, k => parents[k]);
  const service = new AdaptiveSkills(home, home, catalog, owner);
  service.begin("dispatch:exec1:tok");
  const receipt = service.observe("dispatch:exec1:tok", "call-1", "bash", false).match(/[a-f0-9]{24}/)![0];
  await service.save("dispatch:exec1:tok", { name: "table-check", description: "Verify table column extraction", procedure: "Inspect column boundaries after extracting a table. Compare the first and last row before accepting the extraction.", evidence: [receipt], expectedRevision: null });
  service.end("dispatch:exec1:tok");
  // A later worker (nested subagent) and the owning conversation see the recipe.
  for (const key of ["subagent:s1", "matrix:!room"]) {
    service.begin(key);
    assert.match(await service.match(key, "run table-check"), /column boundaries/, key);
    service.end(key);
  }
  // Unrelated conversations and unknown workers stay isolated (no global scope opening).
  for (const key of ["matrix:!other", "dispatch:unknown:tok"]) {
    service.begin(key);
    assert.equal(await service.match(key, "run table-check"), "", key);
    service.end(key);
  }
});

test("learningOwner resolves bounded worker chains and never rewrites conversation keys", () => {
  const chain: Record<string, string> = { "matrix:a": "matrix:b", "dispatch:x:t": "dispatch:x:t" };
  assert.equal(learningOwner("matrix:a", k => chain[k]), "matrix:a");
  assert.equal(learningOwner("dispatch:x:t", k => chain[k]), "dispatch:x:t");
  const loop = (k: string) => k === "subagent:a" ? "subagent:b" : "subagent:a";
  assert.match(learningOwner("subagent:a", loop), /^subagent:/);
});

test("learning reminder appears only after substantial verified work, per run and scope, and stops after a save", async t => {
  const { service, input } = await fixture(t);
  assert.doesNotMatch(service.diagnostics("user:a"), /plugin_skill_learn/); // one receipt: no prompt
  const receipts = [input.evidence[0]];
  for (let n = 0; n < 7; n++) receipts.push(service.observe("user:a", `work-${n}`, "bash", false).match(/[a-f0-9]{24}/)![0]);
  service.observe("user:a", "failed", "bash", true); // errors are not evidence
  assert.match(service.diagnostics("user:a"), /plugin_skill_learn/);
  service.begin("user:b");
  assert.equal(service.diagnostics("user:b"), ""); // other private scope unaffected
  assert.match(await service.save("user:a", { ...input, evidence: receipts.slice(0, 2) }), /"saved":true/);
  assert.doesNotMatch(service.diagnostics("user:a"), /plugin_skill_learn/);
  // The saved recipe is usable in the same owner scope on a later run and invisible elsewhere.
  service.end("user:a"); service.begin("user:a");
  assert.match(await service.match("user:a", "table-check"), /Inspect column boundaries/);
  assert.equal(await service.match("user:b", "table-check"), "");
  service.end("user:a");
  assert.equal(service.diagnostics("user:a"), ""); // drained run leaves no reminder
});

test("full learning path: verified work -> reminder -> create -> later run finds own recipe with revision via search -> revision-bound update", async t => {
  const { catalog, service, input } = await fixture(t);
  const tools = new Map<string, any>();
  await skillSearchPlugin(catalog, (key, q, n) => service.find(key, q, n)).activate({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  const search = tools.get("plugin_skill_search");
  const receipts = [input.evidence[0]];
  for (let n = 0; n < 7; n++) receipts.push(service.observe("user:a", `verified-${n}`, "read", false).match(/[a-f0-9]{24}/)![0]);
  assert.match(service.diagnostics("user:a"), /plugin_skill_learn/);
  await assert.rejects(service.save("user:a", { ...input, evidence: ["not-a-host-receipt"] }), /./); // no blind save without receipts
  const created = JSON.parse((await service.save("user:a", { ...input, evidence: receipts.slice(0, 1) })).split("\n")[0]);
  assert.equal(created.action, "created");
  service.end("user:a");

  // Later owner run: search returns the own recipe with its revision; another scope sees nothing.
  service.begin("user:a"); service.begin("user:b");
  const found = await search.execute({ query: "column" }, { sessionKey: "user:a" });
  assert.match(found, /Learned recipes/);
  assert.match(found, new RegExp(created.revision));
  assert.doesNotMatch(await search.execute({ query: "column" }, { sessionKey: "user:b" }), /table-check/);
  const listed = JSON.parse(found.slice(found.indexOf("[")));
  const receipt = service.observe("user:a", "later-verified", "bash", false).match(/[a-f0-9]{24}/)![0];
  const update = { ...input, procedure: input.procedure + " Re-run on a second sample table.", evidence: [receipt] };
  await assert.rejects(service.save("user:a", { ...update, expectedRevision: null }), /revision conflict.*plugin_skill_search/);
  const updated = JSON.parse((await service.save("user:a", { ...update, expectedRevision: listed[0].revision })).split("\n")[0]);
  assert.equal(updated.action, "updated");
  assert.notEqual(updated.revision, created.revision);
  await assert.rejects(service.save("user:a", { ...update, procedure: update.procedure + " x" }), /write budget/); // attempts are bounded per run
  service.end("user:a"); service.begin("user:a");
  const fresh = service.observe("user:a", "next-run", "bash", false).match(/[a-f0-9]{24}/)![0];
  await assert.rejects(service.save("user:a", { ...update, procedure: update.procedure + " x", evidence: [fresh], expectedRevision: created.revision }), /revision conflict/);
  assert.match(await service.match("user:a", "table-check"), /second sample table/); // updated recipe is what loads
  service.end("user:a"); service.end("user:b");
});
