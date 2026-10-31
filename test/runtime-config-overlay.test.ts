import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm, access, symlink, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadConfig } from "../src/config.js";
import { SettingsService } from "../src/settings.js";
import { pickModelRule } from "../src/dispatcher-config.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { PiSession } from "../src/runtime/pi.js";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import type { Harness } from "../src/harness.js";
import type { ExecutionStore } from "../src/execution.js";

const rules = [
  { match: { minChars: 1200 }, model: "homelab/glm-5.3-flash", thinking: "off" },
  { match: {}, model: "homelab/deepseek-v4-flash", thinking: "off" },
];
const models = rules.map(rule => rule.model);

test("read-only base, writable overlay, atomic runtime reload and restart", async t => {
  assert.notEqual(process.getuid?.(), 0, "fixture must run without root");
  // /etc is root-owned and non-writable; deliberately absent harness.yaml exercises defaults.
  await assert.rejects(access("/etc", 2));
  assert.equal((await loadConfig("/etc")).dispatcher?.enabled, false);
  const home = await mkdtemp(path.join(os.tmpdir(), "runtime-overlay-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // JSON is YAML: the installed root-owned package manifest supplies a real
  // read-only base; unrelated manifest fields are ignored by the existing loader.
  let rootBase = "/opt/vanillacore-harness/package.json";
  if (!(await stat(rootBase).catch(() => undefined))) {
    // Developer/CI machines without the installed package still exercise EACCES.
    rootBase = path.join(home, "read-only-base.yaml");
    await writeFile(rootBase, "dispatcher: { rules: [] }\n", { mode: 0o444 });
  } else {
    assert.equal((await stat(rootBase)).uid, 0);
  }
  await assert.rejects(access(rootBase, 2));
  await symlink(rootBase, path.join(home, "harness.yaml"));
  const originalBase = await readFile(rootBase, "utf8");
  const base = await loadConfig(home);
  const file = path.join(home, "settings.local.yaml");
  const settings = new SettingsService(file, { dispatcher: base.dispatcher, reasoningEffortNoneModels: base.reasoningEffortNoneModels });
  await settings.load();
  assert.deepEqual(settings.effective().dispatcher.rules, base.dispatcher?.rules);
  const overlay = { dispatcher: { rules }, reasoningEffortNoneModels: models };
  await writeFile(file, stringify(overlay));
  await settings.reload();
  assert.equal(pickModelRule("x".repeat(1200), settings.effective().dispatcher.rules)?.model, models[0]);
  assert.equal(pickModelRule("short", settings.effective().dispatcher.rules)?.model, models[1]);
  assert.deepEqual(settings.effective().reasoningEffortNoneModels, models);
  // Actual worker bridge reads the new rules for each future worker.
  const accepted: any[] = [];
  let bridge!: DispatcherRuntime;
  const harness = { accept: async (input: any) => {
    accepted.push(input);
    await bridge.channel.send(input.replyTo, "done");
  } } as unknown as Harness;
  bridge = new DispatcherRuntime(harness, {} as ExecutionStore, async () => {
    await settings.reload();
    return settings.effective().dispatcher?.rules;
  });
  const execute = (text: string) => bridge.strategy.execute({ id: "task", token: "token", input: text } as never, {
    signal: new AbortController().signal, intent: async () => {}, checkpoint: async () => {}, settleIntent: async () => {},
  });
  await execute("x".repeat(1200));
  assert.deepEqual(accepted[0].turn, { model: models[0], thinking: "off" });
  await execute("short");
  assert.deepEqual(accepted[1].turn, { model: models[1], thinking: "off" });

  // Same session, including the reviewer path (ordinary tool-free PiSession),
  // snapshots request metadata after reload and restores local selection after calls.
  const local = { provider: "homelab", id: "deepseek-v4-flash", api: "openai-completions", reasoning: true };
  const payloads: any[] = [];
  let inflight: (() => Promise<void>) | undefined;
  const agent: any = {
    model: local, thinkingLevel: "off", messages: [],
    waitForIdle: async () => {},
    subscribe: () => () => {}, setModel: async (model: any) => { agent.model = model; },
    setThinkingLevel: (thinking: string) => { agent.thinkingLevel = thinking; },
    prompt: async () => {
      payloads.push(agent.model.samplingParamsByThinkingLevel?.off);
      // Run the real provider payload builder; abort in onPayload before HTTP.
      let captured: any;
      const built = stream({ ...agent.model, baseUrl: "http://invalid.test/v1", input: ["text"],
        maxTokens: 1000, contextWindow: 4000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        { messages: [] }, { apiKey: "test-not-a-credential", onPayload: payload => {
          captured = payload; throw Error("STOP_BEFORE_HTTP");
        }, fetch: async () => { throw Error("HTTP forbidden"); } });
      await built.result();
      assert.ok(captured, "real provider reached payload construction");
      assert.equal(captured.reasoning_effort, agent.model.samplingParamsByThinkingLevel?.off?.reasoning_effort);
      await inflight?.();
      agent.messages.push({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "{}" }] });
    },
  };
  const session = new PiSession(agent, {} as never, { current: undefined } as never,
    undefined, undefined, undefined, () => settings.reload(), undefined,
    () => settings.effective().reasoningEffortNoneModels ?? []);
  await session.prompt("review", { thinking: "off" });
  assert.deepEqual(payloads[0], { reasoning_effort: "none" });
  assert.equal(agent.model, local, "local selection metadata restored");
  const valid = settings.effective();
  for (const bad of [
    { ...overlay, unknown: true },
    { ...overlay, approvals: {} },
    { ...overlay, dispatcher: { rules, enabled: true, concurrentRequests: true } },
    { ...overlay, dispatcher: { rules: [{ model: "bad" }] } },
    { ...overlay, reasoningEffortNoneModels: [42] },
    { ...overlay, review: { model: "p/new" } },
  ]) {
    await writeFile(file, stringify(bad));
    await assert.rejects(settings.reload());
    if ("unknown" in bad || "approvals" in bad) await assert.rejects(new SettingsService(file, {}).load());
    assert.deepEqual(settings.effective(), valid, "no partial apply");
  }
  inflight = async () => {
    const snapshot = agent.model;
    await writeFile(file, stringify({ dispatcher: { rules: [] }, reasoningEffortNoneModels: [] }));
    await settings.reload();
    assert.equal(agent.model, snapshot, "reload does not mutate inflight request metadata");
    assert.equal(agent.model.samplingParamsByThinkingLevel.off.reasoning_effort, "none");
  };
  await writeFile(file, stringify(overlay));
  await session.prompt("inflight review", { thinking: "off" });
  inflight = undefined;
  assert.deepEqual(settings.effective().dispatcher.rules, []);
  await session.prompt("next review", { thinking: "off" });
  assert.equal(payloads[2], undefined, "same session observes removed opt-in on the next call");
  assert.equal(agent.model, local);
  await execute("short");
  assert.equal(accepted[2].turn, undefined, "same bridge observes removed rules");
  const restarted = new SettingsService(file, { dispatcher: base.dispatcher });
  await restarted.load();
  assert.deepEqual(restarted.effective().dispatcher, settings.effective().dispatcher);
  assert.deepEqual(restarted.effective().reasoningEffortNoneModels, []);
  assert.match(await readFile(file, "utf8"), /reasoningEffortNoneModels/);
  assert.equal(await readFile(rootBase, "utf8"), originalBase, "immutable base untouched");
});
