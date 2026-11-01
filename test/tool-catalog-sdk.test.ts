import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

test("real SDK reload rebuilds injected catalog and preserves conversation history without model call", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "tool-sdk-")); t.after(() => rm(home, { recursive: true, force: true }));
  const settings = SettingsManager.inMemory();
  let name = "plugin_old";
  const loader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "catalog", factory: pi => { pi.registerTool({ name, label: name, description: name,
      parameters: { type: "object", properties: {} } as any, async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } }); } }] });
  await loader.reload();
  const manager = SessionManager.inMemory(home);
  manager.appendMessage({ role: "user", content: "retained history", timestamp: 1000 });
  const { session } = await createAgentSession({ cwd: home, agentDir: home, settingsManager: settings, resourceLoader: loader, sessionManager: manager });
  t.after(() => session.dispose());
  await session.bindExtensions({});
  assert.ok(session.getAllTools().some(tool => tool.name === "plugin_old"));
  const history = JSON.stringify(session.messages);
  name = "plugin_new"; await session.reload(); await session.bindExtensions({});
  assert.ok(session.getAllTools().some(tool => tool.name === "plugin_new"));
  assert.equal(session.getAllTools().some(tool => tool.name === "plugin_old"), false);
  assert.ok(session.getActiveToolNames().includes("plugin_new"));
  assert.equal(JSON.stringify(session.messages), history);
});
