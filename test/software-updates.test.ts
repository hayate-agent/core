import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeSoftwareUpdates, softwareUpdatePolicy, updateCommand, type UpdateCommand } from "../src/software-updates.js";
import { defaultConfig } from "../src/config.js";

const revisions = { core: "a".repeat(40), plugins: "b".repeat(40), webui: "c".repeat(40) };
async function fixture(options: { vendored?: boolean; tags?: string; history?: string; metadataFailure?: boolean; webuiRestart?: string[]; webuiEnabled?: boolean } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-update-"));
  const events: string[] = [], commands: Array<{ command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  let fail = "";
  const heads = { ...revisions };
  const command: UpdateCommand = async (command, args, cwd, env) => {
    commands.push({ command, args, cwd, env });
    if (fail && args.includes(fail)) throw Error("PRIVATE_NETWORK_TOKEN never returned");
    const component = path.basename(cwd) as keyof typeof revisions;
    if (args[0] === "ls-remote" && args[1] === "--tags") {
      if (options.metadataFailure) throw Error("tag metadata unavailable");
      return options.tags ?? "";
    }
    if (args[0] === "rev-list") return options.history ?? "";
    if (args[0] === "ls-remote") {
      const source = String(args[2]).split("/").at(-1)!.replace(/\.git$/, "") as keyof typeof revisions;
      return heads[source] + "\trefs/heads/main\n";
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
    if (args[0] === "rev-parse") return heads[component] + "\n";
    if (command === "npm" && args[0] === "run" && component === "core") {
      await mkdir(path.join(cwd, "dist")); await writeFile(path.join(cwd, "dist/cli.js"), "// validated fixture");
      await writeFile(path.join(cwd, "dist/launcher.js"), "export function runForeground() {};");
    }
    return "";
  };
  const policy = softwareUpdatePolicy(options.webuiRestart ? { webuiRestart: options.webuiRestart } : {});
  const owner = new NativeSoftwareUpdates(home, policy, (event, detail) => events.push(event + ":" + detail), command, false, undefined, options.webuiEnabled ?? false);
  await owner.open();
  const settled = async (expected: string = "prepared") => {
    for (let n = 0; n < 300; n++) {
      const value = owner.snapshot();
      if (value.phase === expected || value.phase === "failed") return value;
      await new Promise(r => setTimeout(r, 5));
    }
    throw Error("preparation did not settle");
  };
  return { home, owner, events, commands, command, settled, fail: (value: string) => { fail = value; }, advanceCore: () => { heads.core = "d".repeat(40); }, cleanup: async () => { await owner.close(); await rm(home, { recursive: true, force: true }); } };
}

test("update command preserves large tag listings and fails rather than silently truncating", async () => {
  const result = await updateCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(30000))"], process.cwd());
  assert.equal(result.length, 30000);
  await assert.rejects(updateCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1100000))"], process.cwd()), /update command failed/);
});

test("startup defaults: hourly automatic checks, GitHub sources, one 60s restart budget", () => {
  const value = softwareUpdatePolicy();
  assert.equal(value.enabled, true); assert.equal(value.autoInstall, true); assert.equal(value.checkEverySeconds, 3600);
  for (const key of ["core", "plugins", "webui"] as const) assert.equal(value.sources[key].repository, `https://github.com/hayate-agent/${key}.git`);
  assert.equal(defaultConfig().lifecycle?.restartTimeoutSeconds, 60);
  assert.equal(defaultConfig({ lifecycle: { restartTimeoutSeconds: 12 } }).lifecycle?.restartTimeoutSeconds, 12);
  for (const invalid of [0, -1, NaN, Infinity, 1.5, 3601]) assert.throws(() => defaultConfig({ lifecycle: { restartTimeoutSeconds: invalid } }));
  for (const invalid of [-1, NaN, Infinity, 3601]) assert.throws(() => defaultConfig({ loop: { drainSeconds: invalid } as any }));
});

test("activated agent WebUI is restarted natively after selection; disabled or unconfigured WebUI is untouched", async () => {
  const restart = ["systemctl", "--user", "try-restart", "hayate-webui.service"];
  for (const [webuiEnabled, webuiRestart, expected] of [[true, restart, 1], [false, restart, 0], [true, undefined, 0]] as const) {
    const f = await fixture({ webuiEnabled, webuiRestart: webuiRestart ? [...webuiRestart] : undefined });
    try {
      await f.owner.request("update"); assert.equal((await f.settled()).phase, "prepared");
      assert.equal(f.commands.filter(c => c.command === "systemctl").length, 0, "no WebUI restart before old runtime exits");
      await f.owner.afterExit();
      const calls = f.commands.filter(c => c.command === "systemctl");
      assert.equal(calls.length, expected);
      if (expected) {
        assert.deepEqual(calls[0]!.args, restart.slice(1));
        const current = await readFile(path.join(f.home, "software-updates/selected.json"), "utf8");
        assert.ok(current, "selection is committed before the WebUI restart");
        assert.match(f.owner.snapshot().detail, /activated WebUI restarted/);
      }
      assert.equal(f.owner.snapshot().phase, "activated");
    } finally { await f.cleanup(); }
  }
  const f = await fixture({ webuiEnabled: true, webuiRestart: ["systemctl", "--user", "try-restart", "broken-webui.service"] });
  try {
    await f.owner.request("update"); assert.equal((await f.settled()).phase, "prepared"); f.fail("broken-webui.service");
    await f.owner.afterExit();
    assert.equal(f.owner.snapshot().phase, "activated", "WebUI restart failure must not roll back or fail the Core selection");
    assert.match(f.owner.snapshot().detail, /activated WebUI restart failed/);
    assert.match(f.owner.entrypoint("original"), /core\/dist\/cli.js$/);
  } finally { await f.cleanup(); }
  for (const invalid of [[], "systemctl", [""], [1]]) assert.throws(() => softwareUpdatePolicy({ webuiRestart: invalid as any }), /webuiRestart/);
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
    const queued = await f.owner.request("update"); assert.equal(queued.phase, "checking"); assert.ok(queued.requestId);
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

test("candidate startup configuration failure retains active runtime and never announces prepared restart", async () => {
  const f = await fixture();
  try {
    await f.owner.request("update"); assert.equal((await f.settled()).phase, "prepared"); await f.owner.afterExit();
    const before = await readFile(path.join(f.home, "software-updates/selected.json"), "utf8"), entry = f.owner.entrypoint("original");
    f.events.length = 0; f.advanceCore(); f.fail("--eval"); await f.owner.request("update"); const result = await f.settled("failed");
    assert.equal(result.phase, "failed"); assert.match(result.detail!, /startup configuration compatibility failed/);
    assert.equal(await readFile(path.join(f.home, "software-updates/selected.json"), "utf8"), before);
    assert.equal(f.owner.entrypoint("original"), entry); assert.ok(!f.events.some(event => event.startsWith("prepared:")));
    assert.doesNotMatch(result.detail!, /PRIVATE_NETWORK_TOKEN/);
  } finally { await f.cleanup(); }
});

test("installed build metadata records the checked-out version, not package.json's stale base", async () => {
  const f = await fixture({ tags: `${revisions.core}\trefs/tags/v0.1.253` });
  try {
    await f.owner.request("update"); const result = await f.settled(); assert.equal(result.phase, "prepared");
    const info = JSON.parse(await readFile(path.join(f.home, "software-updates/releases", result.pendingSelection!.release, "core/build-info.json"), "utf8"));
    assert.deepEqual(info, { version: "0.1.253", revision: revisions.core });
  } finally { await f.cleanup(); }
});

test("unavailable version metadata does not become an update/restart gate", async () => {
  const f = await fixture({ metadataFailure: true });
  try {
    await f.owner.request("update"); const result = await f.settled(); assert.equal(result.phase, "prepared");
    const info = JSON.parse(await readFile(path.join(f.home, "software-updates/releases", result.pendingSelection!.release, "core/build-info.json"), "utf8"));
    assert.equal(info.version, `0.0.0+git.${revisions.core.slice(0, 12)}`);
    await f.owner.afterExit(); assert.equal(f.owner.snapshot().phase, "activated");
  } finally { await f.cleanup(); }
});

test("public snapshots use hash-locked vendored sources rather than leaking private commit lookups", async () => {
  const f = await fixture({ vendored: true });
  try {
    await f.owner.request("update"); assert.equal((await f.settled()).phase, "prepared");
    assert.ok(!f.commands.some(c => c.args.includes("e".repeat(40)) || c.args.includes("f".repeat(40))));
    const build = f.commands.find(c => c.command === "npm" && c.args[0] === "run" && c.cwd.endsWith("/core"))!;
    assert.ok(build.env?.HAYATE_PLUGIN_SOURCE?.endsWith("/core/vendor/plugins"));
    assert.equal(build.env?.HAYATE_PLUGIN_ASSET_SOURCES, undefined, "removed frontend assets are not prepared even when stale metadata exists");
  } finally { await f.cleanup(); }
});

test("external service owner replacement supersedes a self-update selected from an older base", async () => {
  const f = await fixture();
  try {
    await f.owner.request("update"); await f.settled(); await f.owner.afterExit();
    const replaced = new NativeSoftwareUpdates(f.home, softwareUpdatePolicy(), () => {}, f.command, false, "/new/external/release/cli.js");
    await replaced.open(); assert.equal(replaced.entrypoint("new-external"), "new-external"); replaced.stop();
  } finally { await f.cleanup(); }
});

test("check remains staged across owner restart even with automatic updates enabled", async () => {
  const f = await fixture();
  try {
    await f.owner.request("check");
    assert.equal((await f.settled()).pendingSelection?.installation, "staged");
    const events: string[] = [];
    const restored = new NativeSoftwareUpdates(f.home, softwareUpdatePolicy(), event => events.push(event), async () => { throw Error("staged restore must not fetch"); }, false);
    await restored.open(); restored.start();
    assert.equal(restored.snapshot().phase, "prepared");
    assert.equal(events.includes("prepared"), false);
    await restored.afterExit();
    assert.equal(restored.entrypoint("original"), "original");
    restored.stop();
  } finally { f.owner.stop(); await rm(f.home, { recursive: true, force: true }); }
});

test("a fresh check replaces staged revisions", async () => {
  const f = await fixture();
  try {
    await f.owner.request("check");
    const first = await f.settled();
    f.advanceCore();
    await f.owner.request("check");
    const next = await f.settled();
    assert.notEqual(next.pendingSelection?.plan.id, first.pendingSelection?.plan.id);
    assert.equal(next.pendingSelection?.plan.revisions.core, "d".repeat(40));
    assert.equal(next.pendingSelection?.installation, "staged");
  } finally { f.owner.stop(); await rm(f.home, { recursive: true, force: true }); }
});

test("operator check downloads without activation; install uses only the prepared sources", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.owner.request("install"), /No prepared update/);
    assert.equal(f.commands.length, 0);
    await f.owner.request("check"); assert.equal((await f.settled()).phase, "prepared");
    assert.ok(f.commands.some(c => c.command === "npm"));
    assert.equal(f.events.some(e => e.startsWith("prepared:")), false);
    assert.equal(f.owner.snapshot().pendingSelection?.installation, "staged");
    await f.owner.afterExit();
    assert.equal(f.owner.entrypoint("original"), "original");
    f.advanceCore();
    const before = f.commands.length;
    await f.owner.request("install");
    assert.equal(f.owner.snapshot().pendingSelection?.plan.revisions.core, revisions.core);
    assert.equal(f.commands.length, before, "install does not fetch or rebuild");
    assert.equal(f.events.some(e => e.startsWith("prepared:")), true);
    await f.owner.afterExit();
    assert.equal(f.owner.snapshot().phase, "activated");
  } finally { await f.cleanup(); }
});

test("build failure leaves selection unchanged, redacts secrets and can retry without a permanent busy fence", async () => {
  const f = await fixture();
  try {
    f.fail("build"); await f.owner.request("update"); assert.equal((await f.settled()).phase, "failed");
    assert.equal(f.owner.entrypoint("incumbent"), "incumbent"); assert.ok(!JSON.stringify(f.owner.snapshot()).includes("PRIVATE"));
    f.fail(""); await f.owner.request("update"); assert.equal((await f.settled()).phase, "prepared");
  } finally { await f.cleanup(); }
});

test("prepared transaction survives owner restart without blind build/install replay", async () => {
  const f = await fixture();
  try {
    await f.owner.request("update"); await f.settled(); f.owner.stop();
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

test("WebUI activation is explicit and fail-closed: enabled module activates, disabled or unconfigured does not", async () => {
  const { webuiActivated, webuiActivatedFromHome } = await import("../src/software-updates.js");
  assert.equal(webuiActivated({ webui: { module: "file:///x/webui.js" } }), true);
  assert.equal(webuiActivated({ webui: { module: "file:///x/webui.js", disabled: true } }), false);
  assert.equal(webuiActivated({ webui: { disabled: false } }), false, "baseline-only WebUI is not explicit activation");
  assert.equal(webuiActivated(undefined), false);
  const home = await mkdtemp(path.join(os.tmpdir(), "webui-activation-"));
  try {
    assert.equal(await webuiActivatedFromHome(home), false, "missing settings file stays fail-closed");
    await writeFile(path.join(home, "settings.local.yaml"), "gatewayPlugins:\n  webui:\n    module: file:///x/webui.js\n");
    assert.equal(await webuiActivatedFromHome(home), true);
    await writeFile(path.join(home, "settings.local.yaml"), "gatewayPlugins:\n  webui:\n    module: file:///x/webui.js\n    disabled: true\n");
    assert.equal(await webuiActivatedFromHome(home), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
