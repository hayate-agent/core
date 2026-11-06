// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import { prepareStructuredToolArgs } from "../src/tool-args.js";

const exec = promisify(execFile);

const itemsSchema = {
  type: "object",
  properties: { action: { type: "string" }, items: { type: "array" }, meta: { type: "object" } },
  required: ["action"],
};

test("prepareStructuredToolArgs parses string-encoded declared structured arguments", () => {
  const args = { action: "run", items: '[{"a":1}]', meta: '{"deep":true}' };
  const out = prepareStructuredToolArgs(itemsSchema, args) as Record<string, unknown>;
  assert.deepEqual(out.items, [{ a: 1 }]);
  assert.deepEqual(out.meta, { deep: true });
  assert.equal(out.action, "run");
});

test("prepareStructuredToolArgs keeps non-JSON and shape-mismatched values untouched", () => {
  const out = prepareStructuredToolArgs(itemsSchema, { action: "run", items: "not-json", meta: "[1,2]" }) as Record<string, unknown>;
  assert.equal(out.items, "not-json"); // unparseable: validation must report the real failure
  assert.equal(out.meta, "[1,2]"); // parses to array but property declares object
  const out2 = prepareStructuredToolArgs(itemsSchema, { action: "run", items: '{"a":1}' }) as Record<string, unknown>;
  assert.equal(out2.items, '{"a":1}'); // parses to object but property declares array
  const out3 = prepareStructuredToolArgs(itemsSchema, { action: "run", items: '"5"' }) as Record<string, unknown>;
  assert.equal(out3.items, '"5"'); // parses to a primitive, never a declared shape
  const out4 = prepareStructuredToolArgs(itemsSchema, { action: "run", items: "[{broken" }) as Record<string, unknown>;
  assert.equal(out4.items, "[{broken");
});

test("prepareStructuredToolArgs parses whole-arguments strings and passes through plain args", () => {
  const parsed = prepareStructuredToolArgs(itemsSchema, '{"action":"run","items":[{"a":1}]}') as Record<string, unknown>;
  assert.deepEqual(parsed.items, [{ a: 1 }]);
  const real = { action: "run", items: [{ a: 1 }] };
  assert.strictEqual(prepareStructuredToolArgs(itemsSchema, real), real);
  assert.strictEqual(prepareStructuredToolArgs(itemsSchema, 5), 5);
  assert.strictEqual(prepareStructuredToolArgs(undefined, real), real);
  assert.strictEqual(prepareStructuredToolArgs({ type: "object" }, real), real);
});

test("real PI adapter attaches the prepare hook to plugin tools and prepared args reach execute", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-tool-args-"));
  try {
    const code = `
import assert from "node:assert/strict";
import { PiRuntime } from "./src/runtime/pi.ts";
const tool = {
  name: "plugin_items", description: "Items",
  parameters: { type: "object", properties: { action: { type: "string" }, items: { type: "array" }, meta: { type: "object" } }, required: ["action"] },
  execute: async (input) => JSON.stringify({ action: input.action, items: input.items, meta: input.meta }),
};
const runtime = new PiRuntime({
  cwd: process.env.TEST_HOME, sessionsDir: process.env.TEST_HOME + "/sessions",
  skillPaths: [], personaSections: async () => [], approvals: { mode: "off", tools: [] },
  tools: undefined, pluginTools: () => [tool],
});
const wrapped = await runtime.open("fixture");
try {
  const s = wrapped.session;
  const def = s.extensionRunner.getToolDefinition("plugin_items");
  assert.ok(def, "plugin_items definition");
  const prepared = def.prepareArguments({ action: "run", items: '[{"a":1}]', meta: '{"deep":true}' });
  assert.deepEqual(prepared, { action: "run", items: [{ a: 1 }], meta: { deep: true } });
  const kept = def.prepareArguments({ action: "run", items: "not-json" });
  assert.deepEqual(kept, { action: "run", items: "not-json" });
  const result = await def.execute("call", prepared, undefined, undefined, {});
  assert.deepEqual(JSON.parse(result.content[0].text), { action: "run", items: [{ a: 1 }], meta: { deep: true } });
} finally { await wrapped.dispose(); }
console.log("TOOL_ARGS_OK");`;
    const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      env: { ...process.env, PI_CODING_AGENT_DIR: home, TEST_HOME: home }, timeout: 30000,
    });
    assert.match(result.stdout, /TOOL_ARGS_OK/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
