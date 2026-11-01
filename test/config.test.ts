import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultConfig, loadConfig } from "../src/config.js";

test("MCP is explicitly opt-in and validates enablement", () => {
  assert.deepEqual(defaultConfig().mcp, { enabled: false });
  assert.deepEqual(defaultConfig({ mcp: { enabled: true } }).mcp, { enabled: true });
  for (const mcp of [null, [], true, {}, { enabled: "true" }]) {
    assert.throws(() => defaultConfig({ mcp } as never), /mcp.enabled/);
  }
});

test("tool configuration distinguishes runtime defaults, empty and explicit lists", () => {
  assert.equal(defaultConfig().tools, undefined);
  assert.deepEqual(defaultConfig({ tools: [] }).tools, []);
  const names = ["read", "read", "custom.lookup"];
  assert.deepEqual(defaultConfig({ tools: names }).tools, ["read", "custom.lookup"]);
  assert.deepEqual(names, ["read", "read", "custom.lookup"]);
});

test("tool configuration rejects invalid names, glob/modifier syntax and wrong types", () => {
  for (const tools of [null, "read", [false], [""], ["+bash"], ["*"], ["read write"]]) {
    assert.throws(() => defaultConfig({ tools } as never), /literal tool names/);
  }
});

test("YAML tool selections reach configuration unchanged, including no tools", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-config-"));
  try {
    for (const [yaml, expected] of [["tools: []", []], ["tools: [read, bash]", ["read", "bash"]]] as const) {
      await writeFile(path.join(dir, "hayate-agent.yaml"), yaml);
      assert.deepEqual((await loadConfig(dir)).tools, expected);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("YAML reasoning opt-in reaches config and rejects malformed values", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "harness-reasoning-"));
  try {
    await writeFile(path.join(dir, "hayate-agent.yaml"), "reasoningEffortNoneModels:\n  - homelab/gpt-6.1-sol\n");
    assert.deepEqual((await loadConfig(dir)).reasoningEffortNoneModels, ["homelab/gpt-6.1-sol"]);
    await writeFile(path.join(dir, "hayate-agent.yaml"), "reasoningEffortNoneModels: invalid\n");
    await assert.rejects(loadConfig(dir), /reasoningEffortNoneModels/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reasoningEffortNoneModels validates provider/model refs", () => {
  assert.deepEqual(defaultConfig({ reasoningEffortNoneModels: ["local/reasoner", "homelab/deepseek-v4-flash", "homelab/openai/gpt-oss:120b"] }).reasoningEffortNoneModels,
    ["local/reasoner", "homelab/deepseek-v4-flash", "homelab/openai/gpt-oss:120b"]);
  assert.deepEqual(defaultConfig({}).reasoningEffortNoneModels, []);
  for (const value of ["no-slash", "", 5, ["x"], ["/model"], ["provider/"], ["local/reasoner", "bad space"], ["a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b", "a/b"]]) {
    assert.throws(() => defaultConfig({ reasoningEffortNoneModels: value } as never), /reasoningEffortNoneModels/, JSON.stringify(value));
  }
});
