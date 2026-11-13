import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { defaultConfig } from "../src/config.js";
import { validateGatewayOverlay } from "../src/gateway-provider.js";

const file = (location: string) => readFile(new URL(location, import.meta.url), "utf8");

test("published starter parses as a safe opt-in profile using runtime defaults", async () => {
  const raw = parse(await file("../docs/examples/hayate-agent.yaml"));
  const config = defaultConfig(raw);
  const baseline = defaultConfig();
  assert.deepEqual(config.dispatcher, baseline.dispatcher);
  assert.deepEqual(config.gateways, baseline.gateways);
  assert.deepEqual(config.loop, baseline.loop);
  assert.deepEqual(config.tools, ["read", "bash", "edit", "write", "grep", "find", "ls", "plugin_software_update"]);
  assert.deepEqual(config.lifecycle, baseline.lifecycle);
  assert.deepEqual(config.softwareUpdates, baseline.softwareUpdates);
  assert.equal(config.model, undefined);
  assert.equal(config.thinking, undefined);
  assert.deepEqual(config.plugins, []);
  assert.deepEqual(config.admins, []);
  assert.deepEqual(config.approvers, []);
  assert.equal(raw.gatewayPlugins, undefined);
  assert.equal(raw.contextWindow, undefined);
});

test("gateway walkthrough examples use valid installation/overlay contracts", async () => {
  const guide = await file("../docs/gateways.md");
  const snippets = [...guide.matchAll(/```yaml\n([\s\S]*?)```/g)].map(match => parse(match[1]));
  assert(snippets.length >= 3);
  for (const value of snippets) {
    if (value.gatewayPlugins) validateGatewayOverlay(value.gatewayPlugins);
    else defaultConfig(value);
  }
  assert.match(guide, /MATRIX_ALLOWED_USERS/);
  assert.match(guide, /MATRIX_ADMISSION_ROOMS/);
  assert.match(guide, /separate dashboard and API gateway/);
  assert.match(guide, /no longer packages/);
  assert.doesNotMatch(guide, /plugin_webui_settings|module:\s*plugins\/webui\/index\.mjs/);
  assert.match(guide, /\/approvals manual/);
  assert.doesNotMatch(guide, /\/approvals on/);
});
