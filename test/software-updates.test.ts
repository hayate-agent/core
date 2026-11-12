import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeSoftwareUpdates, softwareUpdatePolicy, type UpdateCommand } from "../src/software-updates.js";
import { defaultConfig } from "../src/config.js";

const revisions = { core: "a".repeat(40), plugins: "b".repeat(40), webui: "c".repeat(40) };
async function fixture(options: { vendored?: boolean } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-update-"));
  const events: string[] = [], commands: Array<{ command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  let fail = "";
  const command: UpdateCommand = async (command, args, cwd, env) => {
    commands.push({ command, args, cwd, env });
    if (fail && args.includes(fail)) throw Error("PRIVATE_NETWORK_TOKEN never returned");
    const component = path.basename(cwd) as keyof typeof revisions;
    if (args[0] === "ls-remote") {
      const source = String(args[2]).split("/").at(-1)!.replace(/\.git$/, "") as keyof typeof revisions;
      return revisions[source] + "\trefs/heads/main\n";
    }
    if (args[0] === "checkout") {
      if (component === "core" || component === "webui") await writeFile(path.join(cwd, "package.json"), '{"scripts":{"build":"test"}}');
      if (component === "core" && options.vendored) {
        await mkdir(path.join(cwd, "vendor/plugins"), { recursive: true });
        await mkdir(path.join(cwd, "vendor/plugin-assets", "f".repeat(40)), { recursive: true });
        await writeFile(path.join(cwd, "plugins.lock.json"), JSON.stringify({ revision: "e".repeat(40), files: {} }));
        await writeFile(path.join(cwd, "plugin-assets.lock.json"), JSON.stringify({ plugins: [{ revision: "f".repeat(40) }] }));
      }
      return "";
    }
    if (args[0] === "rev-parse") return revisions[component] + "\n";
    if (command === "npm" && args[0] === "run" && component === "core") {
      await mkdir(path.join(cwd, "dist")); await writeFile(path.join(cwd, "dist/cli.js"), "// validated fixture");
      await writeFile(path.join(cwd, "dist/launcher.js"), "export function runForeground() {};");
    }
    return "";
  };
  const policy = softwareUpdatePolicy();
  const owner = new NativeSoftwareUpdates(home, policy, (event, detail) => events.push(event + ":" + detail), command, false);
  await owner.open();
  const settled = async (expected: string = "prepared") => {
    for (let n = 0; n < 300; n++) {
      const value = owner.snapshot();
      if (value.phase === expected || value.phase === "failed") return value;
      await new Promise(r => setTimeout(r, 5));
    }
    throw Error("preparation did not settle");
  };
  return { home, owner, events, commands, command, settled, fail: (value: string) => { fail = value; }, cleanup: async () => { await owner.close(); await rm(home, { recursive: true, force: true }); } };
}

test("startup defaults: hourly automatic checks, GitHub sources, one 60s restart budget", () => {
  const value = softwareUpdatePolicy();
  assert.equal(value.enabled, true); assert.equal(value.autoInstall, true); assert.equal(value.checkEverySeconds, 3600);
  for (const key of ["core", "plugins", "webui"] as const) assert.equal(value.sources[key].repository, `https://github.com/hayate-agent/${key}.git`);
  assert.equal(defaultConfig().lifecycle?.restartTimeoutSeconds, 60);
  assert.equal(defaultConfig({ lifecycle: { restartTimeoutSeconds: 12 } }).lifecycle?.restartTimeoutSeconds, 12);
  for (const invalid of [0, -1, NaN, Infinity, 1.5, 3601]) assert.throws(() => defaultConfig({ lifecycle: { restartTimeoutSeconds: invalid } }));
  for (const invalid of [-1, NaN, Infinity, 3601]) assert.throws(() => defaultConfig({ loop: { drainSeconds: invalid } as any }));
});

test("all sources configurable without inheriting internal forge defaults; invalid refs/embedded secrets rejected", () => {
  const policy = softwareUpdatePolicy({ autoInstall: false, sources: { core: { repository: "https://git.vanillacore.net/harness/core.git", branch: "main" } } });
  assert.equal(policy.autoInstall, false); assert.equal(policy.sources.plugins.repository, "https://github.com/hayate-agent/plugins.git");
  for (const repository of ["https://token:secret@github.com/x/y", "--upload-pack=evil", "https://example.com/x?token=private", "garbage"]) assert.throws(() => softwareUpdatePolicy({ sources: { core: { repository } } }));
  for (const branch of ["-main", "a..b", "a b", "a//b"]) assert.throws(() => softwareUpdatePolicy({ sources: { core: { repository: "https://example.com/core.git", branch } } }));
});

test("install is durably scheduled outside command turn; three sources built, no selection before old runtime exits", async () => {
  const f = await fixture();
  try {
    const queued = await f.owner.request("install"); assert.equal(queued.phase, "checking"); assert.ok(queued.requestId);
    const persisted = JSON.parse(await readFile(path.join(f.home, "software-updates/status.json"), "utf8")); assert.equal(persisted.requestId, queued.requestId);
    assert.equal((await f.settled()).phase, "prepared");
    assert.equal(f.commands.filter(c => c.args[0] === "checkout").length, 3);
    assert.equal(f.commands.filter(c => c.command === "npm" && c.args[0] === "run").length, 2);
    assert.ok(!f.commands.some(c => c.command === "npm" && c.args[0] === "test"), "development suites must not block installation or restart");
    assert.match(f.events.join("\n"), /available/); assert.match(f.events.join("\n"), /prepared/);
    await assert.rejects(readFile(path.join(f.home, "software-updates/selected.json")), /ENOENT/);
    assert.equal(f.owner.entrypoint("original"), "original");
    await f.owner.afterExit(); const entry = f.owner.entrypoint("original"); assert.match(entry, /core\/dist\/cli.js$/);
    assert.equal((await f.owner.request("status")).phase, "activated");
    const second = new NativeSoftwareUpdates(f.home, softwareUpdatePolicy(), () => {}, f.command, false);
    await second.open(); assert.equal(second.entrypoint("original"), entry);
    await second.request("check");
    for (let n = 0; n < 200 && second.snapshot().phase === "checking"; n++) await new Promise(r => setTimeout(r, 5));
    assert.equal(second.snapshot().phase, "activated"); second.stop();
  } finally { await f.cleanup(); }
});

test("public snapshots use hash-locked vendored sources rather than leaking private commit lookups", async () => {
  const f = await fixture({ vendored: true });
  try {
    await f.owner.request("install"); assert.equal((await f.settled()).phase, "prepared");
    assert.ok(!f.commands.some(c => c.args.includes("e".repeat(40)) || c.args.includes("f".repeat(40))));
    const build = f.commands.find(c => c.command === "npm" && c.args[0] === "run" && c.cwd.endsWith("/core"))!;
    assert.ok(build.env?.HAYATE_PLUGIN_SOURCE?.endsWith("/core/vendor/plugins"));
    const assets = JSON.parse(build.env!.HAYATE_PLUGIN_ASSET_SOURCES!);
    assert.ok(assets["f".repeat(40)].endsWith("/core/vendor/plugin-assets/" + "f".repeat(40)));
  } finally { await f.cleanup(); }
});

test("external service owner replacement supersedes a self-update selected from an older base", async () => {
  const f = await fixture();
  try {
    await f.owner.request("install"); await f.settled(); await f.owner.afterExit();
    const replaced = new NativeSoftwareUpdates(f.home, softwareUpdatePolicy(), () => {}, f.command, false, "/new/external/release/cli.js");
    await replaced.open(); assert.equal(replaced.entrypoint("new-external"), "new-external"); replaced.stop();
  } finally { await f.cleanup(); }
});

test("operator check prompts, never installs; later explicit install works with same sources", async () => {
  const f = await fixture();
  try {
    await f.owner.request("check"); assert.equal((await f.settled("available")).phase, "available");
    assert.equal(f.commands.filter(c => c.command === "npm").length, 0);
    await f.owner.request("install"); assert.equal((await f.settled()).phase, "prepared");
  } finally { await f.cleanup(); }
});

test("build failure leaves selection unchanged, redacts secrets and can retry without a permanent busy fence", async () => {
  const f = await fixture();
  try {
    f.fail("build"); await f.owner.request("install"); assert.equal((await f.settled()).phase, "failed");
    assert.equal(f.owner.entrypoint("incumbent"), "incumbent"); assert.ok(!JSON.stringify(f.owner.snapshot()).includes("PRIVATE"));
    f.fail(""); await f.owner.request("install"); assert.equal((await f.settled()).phase, "prepared");
  } finally { await f.cleanup(); }
});

test("prepared transaction survives owner restart without blind build/install replay", async () => {
  const f = await fixture();
  try {
    await f.owner.request("install"); await f.settled(); f.owner.stop();
    const events: string[] = [];
    const restored = new NativeSoftwareUpdates(f.home, softwareUpdatePolicy(), e => events.push(e), async () => { throw Error("must not repeat build"); }, false);
    await restored.open(); restored.start(); assert.deepEqual(events, ["prepared"]);
    await restored.afterExit(); assert.notEqual(restored.entrypoint("incumbent"), "incumbent"); restored.stop();
  } finally { await f.cleanup(); }
});

test("containers/disabled updates do not execute native git/npm or select cached installations", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-update-external-"));
  try {
    for (const external of [true, false]) {
      const owner = new NativeSoftwareUpdates(home, softwareUpdatePolicy({ enabled: external }), () => {}, async () => { throw Error("native command forbidden"); }, external);
      await owner.open(); owner.start();
      assert.equal((await owner.request("install")).phase, external ? "external-owner" : "disabled");
      await owner.afterExit(); assert.equal(owner.entrypoint("original"), "original"); owner.stop();
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});
