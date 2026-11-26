import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { capabilityContext } from "../src/capability-context.js";

test("ready dispatcher does not install a Main-only shell or edit guard", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /guardDispatcherMain/);
  assert.match(cli, /subagents\.guardTool\(key, tool\)/);
  assert.match(cli, /dispatchRuntime\?\.guardTool\(key, tool, input\)/);
  const guidance = capabilityContext({ revision: 1, sessionKey: "console:main", selectedTools: undefined,
    registeredTools: ["plugin_dispatch", "bash", "edit", "write"], dispatcherEnabled: true,
    dispatcherReady: true, reviewInstructions: "" });
  assert.match(guidance, /Main may use its available tools directly/);
  assert.match(guidance, /delegation is optional/);
  assert.doesNotMatch(guidance, /Submit with|requestId=|Blocked dispatcher resume/);
});

test("swarm write confinement is the final synchronous guard after awaited guards and approvals", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const pi = await readFile(new URL("../src/runtime/pi.ts", import.meta.url), "utf8");
  assert.match(cli, /finalToolGuard: \(key, tool, input\) => dispatchRuntime\?\.guardSwarmScope\(key, tool, input\)/);
  const handler = pi.slice(pi.indexOf('name: "hayate-agent-approvals"'), pi.indexOf('await loader.reload();'));
  assert.match(handler, /const final = \(\) => \{[\s\S]*finalToolGuard\?\.\(sessionKey, event\.toolName, event\.input\)/);
  // Every allowing return goes through final(); none awaits after it.
  assert.doesNotMatch(handler, /return undefined;\n/);
  assert.match(handler, /return ok \? final\(\) :/);
  assert.equal((handler.match(/return final\(\);/g) ?? []).length, 2);
});
