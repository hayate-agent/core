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
      await writeFile(path.join(dir, "harness.yaml"), yaml);
      assert.deepEqual((await loadConfig(dir)).tools, expected);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
