import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { contextPolicy } from "../src/context-maintenance.js";
import { localContextBudget } from "../src/local-context.js";
import { PiRuntime } from "../src/runtime/pi.js";

test("optional local targets inherit ordinary role budgets; explicit invalid restrictions still fail closed", () => {
  const p = contextPolicy({ mainContextTokens: 131072, workerContextTokens: 65536 });
  assert.equal(p.localMainContextTokens, undefined);
  assert.equal(p.localWorkerContextTokens, undefined);
  assert.equal(localContextBudget(p.mainContextTokens!, false, true, p), 131072);
  assert.equal(localContextBudget(p.workerContextTokens!, true, true, p), 65536);
  for (const value of [0, 4095, -1, 8192.5, NaN, Infinity, null, "8192"]) {
    assert.throws(() => contextPolicy({ localMainContextTokens: value as number }), /Invalid local context token budget/);
    assert.throws(() => contextPolicy({ localWorkerContextTokens: value as number }), /Invalid local context token budget/);
  }
  assert.equal(contextPolicy({ localMainContextTokens: 4096 }).localMainContextTokens, 4096);
  assert.equal(contextPolicy({ localWorkerContextTokens: 8192 }).localWorkerContextTokens, 8192);
});

test("real SDK Main and workers use inherited capacity and restore it after an explicit smaller local override is removed", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "local-context-inheritance-"));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home; process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  models.registerProvider("local-window-fixture", { api: "openai-completions", baseUrl: "https://offline.invalid", apiKey: "offline", models: [{
    id: "model", name: "Offline window fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }] });
  let policy = contextPolicy({ mainContextTokens: 131072, workerContextTokens: 65536, localModels: ["local-window-fixture/model"] });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), model: "local-window-fixture/model", skillPaths: [], tools: [],
    personaSections: async () => [], contextBudgets: () => policy, compactionOwner: () => "agent", approvals: { mode: "off", tools: [] } });
  (runtime as any).modelRuntime = async () => models;
  for (const [key, budget, smaller] of [["matrix:main", 131072, 32768], ["dispatch:task:claim", 65536, 16384], ["subagent:task", 65536, 16384]] as const) {
    const wrapped: any = await runtime.open(key); const sdk = wrapped.session;
    try {
      let expected = budget as number;
      sdk.prompt = async () => {
        const settings = sdk.settingsManager.getCompactionSettings(sdk.model);
        assert.equal(sdk.model.contextWindow, 200000, "physical provider capacity is unchanged");
        assert.equal(sdk.model.contextWindow - settings.reserveTokens, expected);
        assert.equal(wrapped.status().contextBudgetTokens, Math.min(expected, 200000 - sdk.model.maxTokens));
      };
      sdk.waitForIdle = async () => {};
      await wrapped.prompt("Verify inherited capacity; no inference or effects.");
      policy = contextPolicy({ ...policy, localMainContextTokens: 32768, localWorkerContextTokens: 16384 });
      expected = smaller; await wrapped.prompt("Honor an explicit stricter operator target.");
      policy = contextPolicy({ ...policy, localMainContextTokens: undefined, localWorkerContextTokens: undefined });
      expected = budget; await wrapped.prompt("Return to inherited capacity without a stale managed clamp.");
    } finally { await wrapped.dispose(); }
  }
});
