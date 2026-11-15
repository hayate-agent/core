import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { capabilityContext } from "../src/capability-context.js";

test("ready dispatcher does not install a Main-only shell or edit guard", async () => {
  const cli = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.doesNotMatch(cli, /guardDispatcherMain/);
  assert.match(cli, /subagents\.guardTool\(key, tool\)/);
  assert.match(cli, /dispatchRuntime\?\.guardTool\(key, tool\)/);
  const guidance = capabilityContext({ revision: 1, sessionKey: "console:main", selectedTools: undefined,
    registeredTools: ["plugin_dispatch", "bash", "edit", "write"], dispatcherEnabled: true,
    dispatcherReady: true, reviewInstructions: "" });
  assert.match(guidance, /Main may use its available tools directly/);
  assert.match(guidance, /worker actually executing the same work concurrently/);
  assert.match(guidance, /blocked, stalled or failed worker is not by itself a reason to prevent Main from taking over/);
});
