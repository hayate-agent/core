import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { GatewayManager } from "../src/gateway-manager.js";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

async function fixture(t: { after(fn: () => unknown): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "optional-web-")); t.after(() => rm(home, { recursive: true, force: true }));
  const h = new Harness({ runtime: new FakeRuntime(() => "other channel still works") }); h.onStateChange = async () => {}; h.addChannel(new MemoryChannel()); t.after(() => h.stop(0));
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  return { home, h, settings };
}

test("missing configured optional Web gateway AND general plugin never abort other agent channels", async t => {
  const { home, h, settings } = await fixture(t); const file = path.join(home, "dist/optional-plugins/webui/index.mjs");
  await settings.setGatewayPlugin("webui", { module: file }); const before = await readFile(path.join(home, "settings.yaml"), "utf8");
  const manager = new GatewayManager(h, settings, { home, cwd: home, agent: "test" }, {});
  await manager.load(); assert.match(manager.status(), /not installed/); assert.equal(h.channels.has("webui"), false);
  const plugins = new PluginHost(); t.after(() => plugins.stop());
  await plugins.load([file], { home, cwd: home, agent: "test" }, []);
  await h.submit(msg("Continue authorized work")); await h.drained();
  assert.equal(await readFile(path.join(home, "settings.yaml"), "utf8"), before, "no operator configuration rewrite");
  assert.equal(h.state("mem:room1").task?.original, "Continue authorized work");
});

test("explicit Web gateway identity also marks a custom shared plugin entrypoint optional", async t => {
  const { home, h, settings } = await fixture(t); const module = path.join(home, "custom/browser.mjs");
  await settings.setGatewayPlugin("webui", { module }); await new GatewayManager(h, settings, { home, cwd: home, agent: "test" }, {}).load();
  const plugins = new PluginHost(); t.after(() => plugins.stop());
  await plugins.load([module], { home, cwd: home, agent: "test" }, [], [], [], [module]);
});

test("missing unrelated plugin/gateway is still an error, not silently treated as optional", async t => {
  const { home, h, settings } = await fixture(t); await settings.setGatewayPlugin("matrix", { module: "missing.mjs" });
  await assert.rejects(() => new GatewayManager(h, settings, { home, cwd: home, agent: "test" }, {}).load(), /Cannot find module/);
  const plugins = new PluginHost(); t.after(() => plugins.stop());
  await assert.rejects(() => plugins.load(["missing.mjs"], { home, cwd: home, agent: "test" }, []), /Cannot find module/);
});

test("real CLI reaches readiness with a missing configured optional Web module in BOTH loading paths", { timeout: 25000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "optional-web-cli-")); t.after(() => rm(home, { recursive: true, force: true }));
  const module = path.join(home, "dist/optional-plugins/webui/index.mjs");
  await writeFile(path.join(home, "hayate-agent.yaml"), JSON.stringify({ agent: "optional-web-cli", softwareUpdates: { enabled: false }, memory: { enabled: false }, dispatcher: { enabled: false }, mcp: { enabled: false },
    home_address: { channel: "console", target: "local" }, plugins: [module] }));
  await writeFile(path.join(home, "settings.local.yaml"), JSON.stringify({ gatewayPlugins: { webui: { module } } }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(API_SERVER_|MATRIX_|SLACK_|HAYATE_AGENT_|HERMES_)/.test(key)));
  Object.assign(env, { HOME: home, HAYATE_AGENT_HOME: home });
  const child = spawn(process.execPath, ["dist/cli.js", "run", "--home", home, "--console"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
  const ended = new Promise<number | null>(resolve => child.once("exit", resolve));
  try {
    const deadline = Date.now() + 15000;
    while (!/Gestartet und bereit/.test(output)) {
      if (child.exitCode !== null || Date.now() > deadline) assert.fail(`CLI failed to become ready: ${output.slice(-2500)}`);
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.match(output, /Optional Web gateway is not installed/); assert.match(output, /Optional Web plugin is not installed/);
    assert.doesNotMatch(output, /ERR_MODULE_NOT_FOUND/);
  } finally { child.kill("SIGTERM"); await ended; }
});

test("an installed Web module's missing dependency is NOT absence of the optional entrypoint", async t => {
  const { home, h, settings } = await fixture(t); const file = path.join(home, "webui/index.mjs");
  await mkdir(path.dirname(file)); await writeFile(file, "import './missing-security-dependency.mjs'; export default {};");
  await settings.setGatewayPlugin("webui", { module: file });
  await assert.rejects(() => new GatewayManager(h, settings, { home, cwd: home, agent: "test" }, {}).load(), /missing-security-dependency/);
  const plugins = new PluginHost(); t.after(() => plugins.stop());
  await assert.rejects(() => plugins.load([file], { home, cwd: home, agent: "test" }, []), /missing-security-dependency/);
});
