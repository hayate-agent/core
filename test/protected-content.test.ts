import { protectedContentPlugin } from "../src/builtin-plugins/protected-content-plugin.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProtectedContent } from "../src/protected-content.js";
import { SettingsService } from "../src/settings.js";
import { defaultConfig, loadConfig } from "../src/config.js";

test("configured pins survive defaults and YAML loading and enforce integrity", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const text = "operator-controlled identity";
  const sha256 = createHash("sha256").update(text).digest("hex");
  const manifest = { files: [{ path: "SOUL.md", sha256 }] };
  assert.deepEqual(defaultConfig({ home, protectedContent: manifest }).protectedContent, manifest);
  await writeFile(path.join(home, "harness.yaml"), `protectedContent:\n  files:\n    - path: SOUL.md\n      sha256: ${sha256}\n`);
  const config = await loadConfig(home);
  assert.deepEqual(config.protectedContent, manifest);
  const policy = new ProtectedContent(config.home, config.protectedContent);
  const file = path.join(home, "SOUL.md");
  await writeFile(file, text); await policy.verify();
  assert.equal((await policy.inspect()).length, 1);
  await writeFile(file, "tampered");
  await assert.rejects(policy.verify(), /integrity check failed/);
  await rm(file);
  await assert.rejects(policy.verify(), /integrity check failed/);
});

test("protected content pins detect mutation, deletion and recovery without exposing text", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-content-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "SOUL.md");
  const text = "infrastructure identity";
  const sha256 = createHash("sha256").update(text).digest("hex");
  await writeFile(file, text);
  const policy = new ProtectedContent(home, { files: [{ path: "SOUL.md", sha256 }] });
  await policy.verify();
  await writeFile(file, "modified by tool");
  await assert.rejects(policy.verify(), /integrity check failed/);
  assert.equal(JSON.stringify(await policy.inspect()).includes("modified by tool"), false);
  await rm(file); await assert.rejects(policy.verify(), /integrity check failed/);
  await writeFile(file, text); await policy.verify();
});
test("protected content rejects invalid pins and duplicate paths; inspection command is admin-only", async () => {
  assert.throws(() => new ProtectedContent("/tmp", { files: [{ path: "SOUL.md", sha256: "bad" }] }));
  const pin = { path: "SOUL.md", sha256: "a".repeat(64) };
  assert.throws(() => new ProtectedContent("/tmp", { files: [pin, pin] }), /Duplicate/);
  let command: any;
  await protectedContentPlugin(new ProtectedContent("/tmp")).activate({ registerCommand: (c: any) => { command = c; } } as any, {} as any);
  assert.equal(command.admin, true);
  assert.deepEqual(JSON.parse(await command.run("status")).files, []);
});
test("local settings cannot override infrastructure protected-content manifest", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "protected-overlay-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "settings.local.yaml");
  const text = "infrastructure-controlled identity";
  const manifest = { files: [{ path: "SOUL.md", sha256: createHash("sha256").update(text).digest("hex") }] };
  await writeFile(path.join(home, "harness.yaml"), `protectedContent:\n  files:\n    - path: SOUL.md\n      sha256: ${manifest.files[0].sha256}\n`);
  const config = await loadConfig(home);
  const warnings: string[] = [];
  const settings = new SettingsService(file, { reasoningEffortNoneModels: ["p/base"] }, message => warnings.push(message));
  for (const [index, model] of ["p/startup", "p/reloaded"].entries()) {
    // Startup salvages independent fields; invalid live files retain last-good.
    await writeFile(file, `protectedContent:\n  files: []\nreasoningEffortNoneModels: [${model}]\n`);
    if (index === 0) await settings.load(); else await settings.reload();
    assert.deepEqual(settings.effective().reasoningEffortNoneModels, ["p/startup"]);
    assert.equal(Object.hasOwn(settings.snapshot(), "protectedContent"), false);
    assert.equal(Object.hasOwn(settings.effective(), "protectedContent"), false);
    const effective = { ...config, ...settings.effective() };
    assert.deepEqual(effective.protectedContent, manifest);
    assert.deepEqual(config.protectedContent, manifest);
    const policy = new ProtectedContent(home, effective.protectedContent);
    await writeFile(path.join(home, "SOUL.md"), text); await policy.verify();
    await writeFile(path.join(home, "SOUL.md"), "tampered");
    await assert.rejects(policy.verify(), /integrity check failed/);
    assert.equal(settings.diagnostics.length, 1);
    assert.match(settings.diagnostics[0], /Ignored (protectedContent|invalid local settings overlay)/);
    assert.ok(settings.diagnostics[0].length <= 240);
  }
  assert.equal(warnings.length, 2, "one bounded warning per startup/reload, not per pin");
});
