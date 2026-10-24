import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import { gatewaySettings } from "../src/gateway-settings.js";
import { Harness } from "../src/harness.js";
import type { Channel } from "../src/types.js";

test("global gateway defaults and partial per-gateway overrides", () => {
  const { gateways } = defaultConfig({ gateways: {
    progress: "reduced", statusReactions: true,
    overrides: { matrix: { progress: "full" }, slack: { statusReactions: false }, telegram: { progress: "off" } },
  } });
  assert.deepEqual(gatewaySettings(gateways,"matrix"), {progress:"full",statusReactions:true});
  assert.deepEqual(gatewaySettings(gateways,"slack"), {progress:"reduced",statusReactions:false});
  assert.deepEqual(gatewaySettings(gateways,"telegram"), {progress:"off",statusReactions:true});
  assert.deepEqual(gatewaySettings(gateways,"future"), {progress:"reduced",statusReactions:true});
  assert.deepEqual(gatewaySettings(defaultConfig().gateways,"matrix"), {progress:"off",statusReactions:false});
});
test("gateway configuration rejects invalid nested policy", () => {
  for (const gateways of [null, [], {progress:"verbose"}, {statusReactions:"false"}, {overrides:[]}, {overrides:{matrix:{progress:null}}}, {overrides:{slack:{statusReactions:0}}}, {overrides:{telegram:{typo:true}}}]) {
    assert.throws(() => defaultConfig({gateways} as any));
  }
});
test("Harness configures any gateway before startup, including future plugin channels", () => {
  const seen: unknown[] = [];
  const harness = new Harness({runtime: {} as any, tickMs:1000, busyMode:"queue", gateways:{progress:"full",statusReactions:true,overrides:{telegram:{progress:"off"}}}});
  for (const name of ["slack", "telegram", "future"]) {
    harness.addChannel({ name, configureGateway(settings) {seen.push([name,settings]);}, async start() {}, async send() {}, async stop() {} } satisfies Channel);
  }
  assert.deepEqual(seen, [["slack",{progress:"full",statusReactions:true}],["telegram",{progress:"off",statusReactions:true}],["future",{progress:"full",statusReactions:true}]]);
});
