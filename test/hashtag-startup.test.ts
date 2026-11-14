import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config.js";
import { Harness } from "../src/harness.js";
import { createHashtagStartup } from "../src/hashtag-startup.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import type { OpenSessionOptions, PromptOptions } from "../src/types.js";
import { FakeRuntime, FakeSession, MemoryChannel, msg } from "./fakes.js";

const verdict = '{"topic":null,"inherit":false,"tags":["startup-metadata"]}';
class MetadataRuntime extends FakeRuntime {
  metadata: Array<{ open: OpenSessionOptions; prompt?: string; options?: PromptOptions; aborts: number; disposals: number }> = [];
  response = (_prompt: string): string => verdict;
  holding = false;
  entered = Promise.withResolvers<void>();
  disposed = Promise.withResolvers<void>();
  override async open(key: string, open: OpenSessionOptions = {}) {
    if (!open.ephemeral) return super.open(key, open);
    const call: MetadataRuntime["metadata"][number] = { open, aborts: 0, disposals: 0 };
    this.metadata.push(call);
    const session = new FakeSession(key, prompt => this.response(prompt));
    if (this.holding) session.hold();
    const prompt = session.prompt.bind(session), abort = session.abort.bind(session);
    session.prompt = async (text, options) => {
      call.prompt = text; call.options = options; this.entered.resolve();
      return prompt(text, options);
    };
    session.abort = async () => { call.aborts++; await abort(); };
    session.dispose = () => { call.disposals++; this.disposed.resolve(); };
    return session;
  }
}

async function fixture(t: TestContext, extra = "") {
  const home = await mkdtemp(path.join(os.tmpdir(), "hashtag-startup-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "hayate-agent.yaml"), `model: fixture/main\nreview:\n  model: fixture/review\nmodelRoles:\n  enabled: true\n  roles:\n    hashtag: {model: fixture/legacy}\n    reviewer: {model: fixture/reviewer}\n    dispatcher: {model: fixture/dispatcher}\n${extra}`);
  await writeFile(path.join(home, "custom-topics.mjs"), `export default { apiVersion: 1, activate(api) {
    api.registerService("topic-labeler-custom-topics", 1, { label: async (text, candidates, recent, signal) => {
      if (!(signal instanceof AbortSignal) || signal.aborted) throw Error("missing live signal");
      return ["custom-provider"];
    } });
  } };`);
  const config = await loadConfig(home);
  const settings = new SettingsService(path.join(home, "settings.local.yaml"), {
    model: config.model, hashtag: config.hashtag, review: config.reviewOverrides, modelRoles: config.modelRoles,
  });
  await settings.load();
  const runtime = new MetadataRuntime(() => "business answer");
  const plugins = new PluginHost();
  t.after(() => plugins.stop());
  const startup = createHashtagStartup(runtime, settings, plugins);
  await plugins.load(config.plugins ?? [], { agent: config.agent, home, cwd: home }, [], [], [startup.plugin]);
  const harness = new Harness({ runtime, agent: config.agent, approvalDir: path.join(home, "approvals"),
    busyMode: "queue", tickMs: 60000, topicLabeler: startup.topicLabeler });
  const channel = new MemoryChannel(); harness.addChannel(channel);
  await harness.start(); t.after(() => harness.stop(1000));
  const send = async (text: string, key = "mem:room1") => {
    await harness.accept(msg(text, "@owner:x", key));
    await harness.drained();
  };
  return { home, config, settings, runtime, plugins, startup, harness, channel, send };
}

function assertMetadata(call: MetadataRuntime["metadata"][number], model: string) {
  assert.deepEqual(call.open, { ephemeral: true, assessmentPurpose: "hashtag" });
  assert.deepEqual(call.options, { model, thinking: "off" });
  assert.equal(call.disposals, 1);
  assert.match(call.prompt!, /tool-free metadata classifier/);
}

test("YAML startup -> settings -> plugin registry -> actual Harness ingress uses explicit metadata model and Main-only reset", { timeout: 10000 }, async t => {
  const f = await fixture(t, "hashtag:\n  model: fixture/installed\n");
  await f.send("initial database repair");
  assertMetadata(f.runtime.metadata[0]!, "fixture/installed");
  assert.equal(f.channel.texts().at(-1), "#startup-metadata · business answer");
  await f.settings.set("hashtag.model", "fixture/live");
  await f.send("second unique database repair");
  assertMetadata(f.runtime.metadata[1]!, "fixture/live");
  const restarted = new SettingsService(path.join(f.home, "settings.local.yaml"), {
    model: f.config.model, hashtag: f.config.hashtag, modelRoles: f.config.modelRoles,
  });
  await restarted.load();
  const restartedStartup = createHashtagStartup(f.runtime, restarted, f.plugins);
  const h = new Harness({ runtime: f.runtime, agent: "restart", approvalDir: path.join(f.home, "restart-approvals"),
    tickMs: 60000, busyMode: "queue", topicLabeler: restartedStartup.topicLabeler });
  h.addChannel(new MemoryChannel()); await h.start(); t.after(() => h.stop(1000));
  await h.accept(msg("fresh restart turn", "@owner:x", "mem:restart")); await h.drained();
  assertMetadata(f.runtime.metadata[2]!, "fixture/live");
  await f.settings.set("hashtag.model");
  await f.send("reset restores installation model");
  assertMetadata(f.runtime.metadata[3]!, "fixture/installed");
  await f.settings.set("hashtag.model", "fixture/live-again");
  await writeFile(path.join(f.home, "settings.local.yaml"), "{}\n");
  await f.settings.reload();
  await f.send("overlay file reset restores installation model");
  assertMetadata(f.runtime.metadata[4]!, "fixture/installed");
});

test("unset hashtag override ignores legacy hashtag/reviewer/dispatcher roles; live Main changes and persisted reset reach ingress", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.send("unset override first ingress"); assertMetadata(f.runtime.metadata[0]!, "fixture/main");
  await f.settings.set("model", "fixture/new-main");
  await f.send("Main changed without restart"); assertMetadata(f.runtime.metadata[1]!, "fixture/new-main");
  await f.settings.set("hashtag.model", "fixture/local");
  await f.send("local explicit metadata model"); assertMetadata(f.runtime.metadata[2]!, "fixture/local");
  await f.settings.set("hashtag.model");
  await f.send("reset inherits changed Main"); assertMetadata(f.runtime.metadata[3]!, "fixture/new-main");
  const restarted = new SettingsService(path.join(f.home, "settings.local.yaml"), { model: f.config.model, modelRoles: f.config.modelRoles });
  await restarted.load();
  assert.equal(restarted.effective().hashtag?.model, undefined);
  assert.equal(restarted.effective().model, "fixture/new-main");
});

test("YAML custom provider loads through PluginHost and serves the same Harness path without default inference", { timeout: 10000 }, async t => {
  const f = await fixture(t, 'hashtag:\n  provider: custom-topics\nplugins: ["./custom-topics.mjs"]\n');
  await f.send("custom service ingress");
  assert.equal(f.channel.texts().at(-1), "#custom-provider · business answer");
  assert.equal(f.runtime.metadata.length, 0);
  // Provider selection is startup-bound; a YAML reset is tested by a new startup below.
  const semantic = await fixture(t);
  await semantic.send("default semantic inference restored");
  assertMetadata(semantic.runtime.metadata[0]!, "fixture/main");
  await writeFile(path.join(f.home, "settings.local.yaml"), "hashtag:\n  provider: tags-only\n  model: fixture/live-metadata\n");
  await f.settings.reload();
  assert.equal(f.settings.effective().hashtag?.provider, "custom-topics");
  assert.equal(f.settings.desired().hashtag?.provider, "tags-only");
  assert.ok(f.settings.restartPending.includes("hashtag"));
  await f.send("provider remains custom until restart");
  assert.equal(f.channel.texts().at(-1), "#custom-provider · business answer");
  assert.equal(f.runtime.metadata.length, 0);
  const settings = new SettingsService(path.join(f.home, "settings.local.yaml"), { model: f.config.model, hashtag: f.config.hashtag });
  await settings.load();
  assert.equal(settings.effective().hashtag?.provider, "tags-only");
  const startup = createHashtagStartup(f.runtime, settings, f.plugins);
  const h = new Harness({ runtime: f.runtime, agent: "provider-restart", approvalDir: path.join(f.home, "provider-restart-approvals"),
    tickMs: 60000, busyMode: "queue", topicLabeler: startup.topicLabeler });
  const channel = new MemoryChannel(); h.addChannel(channel); await h.start(); t.after(() => h.stop(1000));
  f.runtime.response = () => '["after-restart"]';
  await h.accept(msg("provider activated after restart", "@owner:x", "mem:provider-restart")); await h.drained();
  assertMetadataPurposeOnly(f.runtime.metadata[0]!, "fixture/live-metadata");
  assert.equal(channel.texts().at(-1), "#after-restart · business answer");
});

test("unknown explicitly selected provider fails neutral without default model inference", { timeout: 10000 }, async t => {
  const f = await fixture(t, "hashtag:\n  provider: missing-provider\n");
  await f.send("unknown provider business input");
  assert.equal(f.channel.texts().at(-1), "#topic-clarification · business answer");
  assert.equal(f.runtime.metadata.length, 0);
});

test("legacy default service remains compatible with actual ingress", { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await f.plugins.load([], { agent: f.config.agent, home: f.home, cwd: f.home }, [], [], [{ apiVersion: 1, activate(api) {
    api.registerService("topic-labeler", 1, { label: async () => ["legacy-provider"] });
  } }]);
  await f.send("legacy service input");
  assert.equal(f.channel.texts().at(-1), "#legacy-provider · business answer");
  assert.equal(f.runtime.metadata.length, 0);
});

test("tags-only provider is opt-in; isolated sessions, no umbrella claim, default semantic startup preserves inheritance", { timeout: 10000 }, async t => {
  const f = await fixture(t, "hashtag:\n  provider: tags-only\n");
  await f.send("seed database repair #storage", "mem:database");
  await f.send("seed DNS repair #network", "mem:dns");
  f.runtime.response = prompt => {
    assert.match(prompt, /Return ONLY a JSON array/);
    return '["independent-tag"]';
  };
  await f.send("continue the database repair", "mem:database");
  assert.equal(f.channel.texts().at(-1), "#independent-tag · business answer");
  assertMetadataPurposeOnly(f.runtime.metadata[0]!);
  await f.send("continue DNS repair", "mem:dns");
  assert.equal(f.channel.texts().at(-1), "#independent-tag · business answer");
  assert.equal(f.runtime.metadata.length, 2);
  const semantic = await fixture(t);
  await semantic.send("seed database repair #storage", "mem:database");
  await semantic.send("seed DNS repair #network", "mem:dns");
  semantic.runtime.response = prompt => {
    const data = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    assert.ok(data.candidates.length > 0);
    assert.ok(data.candidates.every((item: { tags: string[] }) => !item.tags.includes("network")), "other session cannot leak candidates");
    const candidate = data.candidates.find((item: { tags: string[] }) => item.tags.includes("storage"));
    assert.ok(candidate);
    return JSON.stringify({ topic: candidate.id, inherit: true, tags: ["continued-repair"] });
  };
  await semantic.send("resume original database repair", "mem:database");
  assert.match(semantic.channel.texts().at(-1)!, /#continued-repair #storage/);
  assertMetadata(semantic.runtime.metadata[0]!, "fixture/main");
});
function assertMetadataPurposeOnly(call: MetadataRuntime["metadata"][number], model = "fixture/main") {
  assert.deepEqual(call.open, { ephemeral: true, assessmentPurpose: "hashtag" });
  assert.deepEqual(call.options, { model, thinking: "off" });
  assert.equal(call.disposals, 1);
}

test("startup factory propagates caller cancellation to held metadata runtime abort/dispose", { timeout: 10000 }, async t => {
  const f = await fixture(t); f.runtime.holding = true;
  const controller = new AbortController();
  const pending = f.startup.topicLabeler("cancelled synthetic input", [], [], controller.signal);
  await f.runtime.entered.promise; controller.abort();
  assert.deepEqual(await pending, ["topic-clarification"]);
  await f.runtime.disposed.promise;
  assert.equal(f.runtime.metadata[0]!.aborts, 1);
  assertMetadata(f.runtime.metadata[0]!, "fixture/main");
});

test("real Harness metadata deadline aborts/disposes held runtime and admits business input with neutral metadata", { timeout: 10000 }, async t => {
  const f = await fixture(t); f.runtime.holding = true;
  await f.harness.accept(msg("held metadata must not drop input"));
  await f.runtime.entered.promise;
  await f.runtime.disposed.promise;
  // The production 2s deadline, not a sleep/release pretending successful cancellation.
  await f.harness.drained();
  assert.equal(f.runtime.metadata[0]!.aborts, 1);
  assert.equal(f.runtime.metadata[0]!.disposals, 1);
  assert.equal(f.harness.pendingInputs().length, 0);
  assert.deepEqual(f.channel.texts(), ["#topic-clarification · business answer"]);
  assert.equal(f.runtime.opened.length, 1, "business inference proceeds after neutral metadata fallback");
});

test("production CLI consumes the factory tested above, with tool-free PI purpose isolation", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /const hashtag = createHashtagStartup\(runtime, settings, plugins\)/);
  assert.match(cli, /topicLabeler: hashtag\.topicLabeler/);
  assert.match(cli, /languageService\([^\n]+hashtag\.plugin/);
  const pi = await readFile(new URL("../src/runtime/pi.ts", import.meta.url), "utf8");
  assert.match(pi, /options.assessmentPurpose === "hashtag"/);
  assert.match(pi, /noTools: options.ephemeral/);
  assert.match(pi, /noContextFiles: options.ephemeral/);
  assert.match(pi, /noSkills: options.ephemeral/);
  assert.match(pi, /tools: options.ephemeral \? \[\]/);
  assert.match(pi, /extensionFactories: options.ephemeral \? \[\]/);
});
