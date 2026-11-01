import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initialize, diagnose } from "../src/setup.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { personaSections } from "../src/persona.js";

const root = new URL("../", import.meta.url);
const text = (file: string) => readFile(new URL(file, root), "utf8");

test("CLI displays Hayate Agent while keeping the legacy executable", () => {
  const help = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--help"], { cwd: root, encoding: "utf8" });
  assert.match(help, /^Hayate Agent /);
  assert.match(help, /Interactive Hayate Agent TUI/);
  assert.match(help, /vanillacore-harness run/);
  assert.match(help, /VANILLACORE_HARNESS_HOME/);
  assert.doesNotMatch(help, /VanillaCore Agent Harness/);
});

test("package keeps technical identifiers while docs use canonical repositories", async () => {
  const pkg = JSON.parse(await text("package.json"));
  assert.match(pkg.description, /^Hayate Agent:/);
  assert.equal(pkg.name, "vanillacore-harness");
  assert.deepEqual(pkg.bin, { "vanillacore-harness": "./dist/cli.js" });
  assert.equal(pkg.repository.url, "https://git.vanillacore.net/harness/core.git");
  assert.equal(JSON.parse(await text("package-lock.json")).name, pkg.name);
  assert.match(await text("README.md"), /^# Hayate Agent\n/);
  const readme = await text("README.md");
  assert.match(readme, /git clone https:\/\/github\.com\/hayate-agent\/core\.git/);
  for (const repo of ["core", "plugins", "deployments"]) {
    assert.ok(readme.includes(`https://github.com/hayate-agent/${repo}`));
  }
  assert.doesNotMatch(readme, /Repository names and URLs .*are\s+unchanged/s);
  assert.match(await text("docs/installation.md"), /git clone https:\/\/github\.com\/hayate-agent\/core\.git/);
  assert.match(await text("docs/development.md"), /^# Developing and extending Hayate Agent/);
  assert.match(await text("deploy/kubernetes/SOUL.md"), /running in Hayate Agent/);
  assert.match(defaultConfig().home, /\.vanillacore-harness$/);
});

test("new persona and diagnostics use product name but preserve configured identity and state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hayate-naming-"));
  try {
    const opts = { home: path.join(dir, "home"), cwd: dir, agent: "custom-agent" };
    await initialize(opts);
    const soul = await readFile(path.join(opts.home, "SOUL.md"), "utf8");
    assert.match(soul, /You are custom-agent/);
    assert.match(soul, /running in Hayate Agent/);
    assert.equal((await loadConfig(opts.home)).agent, "custom-agent");
    assert.deepEqual(await initialize({ ...opts, agent: "other" }), []);
    assert.equal(await readFile(path.join(opts.home, "SOUL.md"), "utf8"), soul);
    assert.equal((await diagnose(opts.home)).lines[0], "Hayate Agent diagnostics");
    const sections = personaSections({ soul: "Retain this operator identity." }, { name: "custom-agent" });
    assert.match(sections[0], /running in Hayate Agent/);
    assert.match(sections[0], /configured agent key is "custom-agent"/);
    assert.match(sections.join("\n"), /Retain this operator identity/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
