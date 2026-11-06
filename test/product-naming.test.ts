import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentHome, configurationFile, reasoningEffortNoneModels } from "../src/product-paths.js";
import { initialize, diagnose } from "../src/setup.js";
import { loadConfig } from "../src/config.js";

test("canonical defaults and explicit precedence preserve existing local homes without moving state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hayate-paths-"));
  try {
    const canonical = path.join(root, ".hayate-agent"), legacy = path.join(root, ".vanillacore-harness");
    assert.equal(agentHome(undefined, {}, root), canonical);
    await mkdir(legacy);
    await writeFile(path.join(legacy, "harness.yaml"), "agent: existing\n");
    assert.equal(agentHome(undefined, {}, root), canonical);
    assert.equal(configurationFile(legacy), path.join(legacy, "hayate-agent.yaml"));
    assert.notEqual((await loadConfig(legacy)).agent, "existing");
    await mkdir(canonical);
    assert.equal(agentHome(undefined, {}, root), canonical);
    const env = { HAYATE_AGENT_HOME: canonical, VANILLACORE_HARNESS_HOME: legacy };
    assert.equal(agentHome(undefined, env, root), canonical);
    assert.equal(agentHome(legacy, env, root), legacy);
    assert.equal(agentHome(undefined, { VANILLACORE_HARNESS_HOME: legacy }, root), canonical);
    assert.equal(agentHome(undefined, { HAYATE_AGENT_HOME: legacy }, root), legacy);
    await writeFile(path.join(legacy, "hayate-agent.yaml"), "agent: canonical\n");
    assert.equal((await loadConfig(legacy)).agent, "canonical");
    await initialize({ home: legacy, cwd: root });
    assert.equal((await loadConfig(legacy)).agent, "canonical");
    assert.equal((await diagnose(legacy)).ok, true);
    assert.equal(await readFile(path.join(legacy, "harness.yaml"), "utf8"), "agent: existing\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reasoning environment canonical precedence includes explicit empty opt-out", () => {
  assert.deepEqual(reasoningEffortNoneModels({ HAYATE_AGENT_REASONING_EFFORT_NONE_MODELS: " p/a, p/b, ", HARNESS_REASONING_EFFORT_NONE_MODELS: "old/model" }), ["p/a", "p/b"]);
  assert.deepEqual(reasoningEffortNoneModels({ HAYATE_AGENT_REASONING_EFFORT_NONE_MODELS: "", HARNESS_REASONING_EFFORT_NONE_MODELS: "old/model" }), []);
  assert.deepEqual(reasoningEffortNoneModels({ HARNESS_REASONING_EFFORT_NONE_MODELS: "old/model" }), []);
});

test("built npm executable uses Hayate help, init, doctor and restart configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hayate-cli-"));
  try {
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(pkg.name, "hayate-agent");
    assert.deepEqual(pkg.bin, { "hayate-agent": "./dist/launcher.js" });
    const executable = path.resolve(pkg.bin["hayate-agent"]);
    const env = { ...process.env, HOME: root, HAYATE_AGENT_AGENT: "canonical-agent" };
    const ignoredHome = path.join(root, ".vanillacore-harness");
    await mkdir(ignoredHome);
    await writeFile(path.join(ignoredHome, "harness.yaml"), "agent: ignored-agent\n");
    Object.assign(env, { VANILLACORE_HARNESS_HOME: ignoredHome, VANILLACORE_HARNESS_AGENT: "ignored-agent" });
    delete env.HAYATE_AGENT_HOME;
    const cli = (...args: string[]) => execFileSync(process.execPath, [executable, ...args], { env, encoding: "utf8" });
    const help = cli("--help");
    assert.match(help, /hayate-agent init/);
    assert.match(help, /HAYATE_AGENT_HOME/);
    assert.doesNotMatch(help, /vanillacore-harness|harness\.yaml/);
    cli("init", "--cwd", root);
    const home = path.join(root, ".hayate-agent");
    const yaml = await readFile(path.join(home, "hayate-agent.yaml"), "utf8");
    assert.match(yaml, /canonical-agent/);
    assert.equal(await readFile(path.join(ignoredHome, "harness.yaml"), "utf8"), "agent: ignored-agent\n");
    delete (env as NodeJS.ProcessEnv).HAYATE_AGENT_AGENT;
    const explicitHome = path.join(root, "explicit-state");
    await mkdir(explicitHome);
    await writeFile(path.join(explicitHome, "harness.yaml"), "agent: ignored-agent\n");
    cli("init", "--home", explicitHome, "--cwd", root);
    assert.match(await readFile(path.join(explicitHome, "hayate-agent.yaml"), "utf8"), /agent: agent\n/);
    assert.equal(await readFile(path.join(explicitHome, "harness.yaml"), "utf8"), "agent: ignored-agent\n");
    Object.assign(env, { HAYATE_AGENT_HOME: explicitHome });
    assert.match(cli("doctor"), /Hayate Agent diagnostics/);
    cli("init", "--home", home, "--agent", "must-not-overwrite");
    delete (env as NodeJS.ProcessEnv).HAYATE_AGENT_HOME;
    assert.match(cli("doctor"), /Hayate Agent diagnostics/);
    cli("init", "--agent", "must-not-overwrite");
    assert.equal(await readFile(path.join(home, "hayate-agent.yaml"), "utf8"), yaml);
    assert.equal(cli("version").trim(), pkg.version);
    const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/tini", "--", "hayate-agent"\]/);
    assert.match(dockerfile, /\/opt\/hayate-agent\/dist\/cli.js \/usr\/local\/bin\/hayate-agent/);
    assert.doesNotMatch(dockerfile, /VANILLACORE_HARNESS_HOME=/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
