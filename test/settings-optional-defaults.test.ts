import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { defaultConfig } from "../src/config.js";
import { SettingsService, type LocalSettings } from "../src/settings.js";

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
