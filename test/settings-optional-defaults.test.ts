import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultConfig } from "../src/config.js";
import { SettingsService, type LocalSettings } from "../src/settings.js";

for (const layered of [false, true]) test(`installation-only adaptive skills do not block gateway reload or permit overlay opt-in (drop-ins=${layered})`, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-adaptive-settings-"));
  try {
    if (layered) await mkdir(path.join(home, "settings.d"));
    const config = defaultConfig({ home, skills: { paths: [], adaptive: true } });
    const file = path.join(home, "settings.local.yaml");
    await writeFile(file, "gatewayPlugins:\n  slack:\n    module: /installed/old.mjs\n");
    const settings = new SettingsService(file, { skills: config.skills });
    await settings.load();
    assert.equal(settings.desired().gatewayPlugins?.slack?.module, "/installed/old.mjs");
    assert.equal(settings.effective().skills?.context, "auto");
    assert.equal(Object.hasOwn(settings.effective().skills!, "adaptive"), false);
    assert.equal(config.skills.adaptive, true, "installation switch is not mutated");
    let requested: string | undefined;
    settings.onPluginReload(async () => { requested = settings.desired().gatewayPlugins?.slack?.module; });
    await writeFile(file, "gatewayPlugins:\n  slack:\n    module: /installed/fixed.mjs\n");
    await settings.reload();
    assert.equal(requested, "/installed/fixed.mjs");
    assert.equal(settings.desired().gatewayPlugins?.slack?.module, "/installed/fixed.mjs");
    await assert.rejects(settings.set("skills.adaptive" as never, true), /Unsupported|Invalid/);
    await writeFile(file, "skills:\n  adaptive: true\ngatewayPlugins:\n  slack:\n    module: /untrusted.mjs\n");
    if (layered) await assert.rejects(settings.reload(), /Invalid|Unsupported/);
    else await settings.reload();
    assert.equal(settings.desired().gatewayPlugins?.slack?.module, "/installed/fixed.mjs");
    assert.equal(Object.hasOwn(settings.effective().skills!, "adaptive"), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("strict drop-ins accept the actual CLI defaults with unset model/role/review fields", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-optional-defaults-"));
  try {
    const config = defaultConfig({ home, cwd: home, model: "provider/example", dispatcher: { enabled: true, concurrentRequests: true } });
    const defaults: LocalSettings = {
      model: config.model, thinking: config.thinking, dispatcher: config.dispatcher,
      modelRoles: config.modelRoles, reasoningEffortNoneModels: config.reasoningEffortNoneModels,
      gateways: config.gateways, memory: config.memory, skills: config.skills,
      contextMaintenance: config.contextMaintenance, toolResultPruning: config.toolResultPruning,
      review: { model: config.reviewOverrides?.model, thinking: config.reviewOverrides?.thinking },
    };
    assert.equal(Object.hasOwn(defaults, "thinking"), true);
    await mkdir(path.join(home, "settings.d"));
    const file = path.join(home, "settings.d/95-webui.yaml");
    await writeFile(file, "gatewayPlugins:\n  webui:\n    module: /installed/webui/index.mjs\n");
    const settings = new SettingsService(path.join(home, "settings.local.yaml"), defaults);
    await settings.load();
    assert.deepEqual(settings.diagnostics, []);
    assert.equal(settings.desired().gatewayPlugins?.webui?.module, "/installed/webui/index.mjs");
    assert.equal(settings.effective().model, "provider/example");
    assert.equal(settings.effective().dispatcher?.enabled, true);
    assert.equal(settings.effective().modelRoles, undefined);
    assert.equal(settings.effective().thinking, undefined);
    defaults.model = "changed-after-construction";
    assert.equal(settings.effective().model, "provider/example", "Defaults are captured, not a shared mutable reference");
    await writeFile(file, "thinking: null\ngatewayPlugins:\n  webui:\n    module: /other.mjs\n");
    await assert.rejects(settings.reload(), /Invalid or unreadable settings file/);
    assert.equal(settings.desired().gatewayPlugins?.webui?.module, "/installed/webui/index.mjs");
    assert.equal(settings.effective().model, "provider/example");
  } finally { await rm(home, { recursive: true, force: true }); }
});
