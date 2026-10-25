import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import { dispatcherConfig } from "../src/dispatcher-config.js";

test("dispatcher stays off without explicit concurrency support", () => {
  assert.equal(dispatcherConfig().enabled, false);
  assert.throws(() => defaultConfig({ dispatcher: { enabled: true } }), /concurrentRequests/);
  const config = defaultConfig({ dispatcher: { enabled: true, concurrentRequests: true, capacity: 7, strategy: "custom" } });
  assert.deepEqual(config.dispatcher, { enabled: true, concurrentRequests: true, capacity: 7, strategy: "custom", retentionDays: 7 });
});
test("dispatcher rejects invalid capacity and policy", () => {
  for (const capacity of [0, -1, 1.5, Infinity]) assert.throws(() => dispatcherConfig({ capacity }), /Invalid/);
  for (const retentionDays of [0, -1, 1.5, 3651, Infinity]) assert.throws(() => dispatcherConfig({ retentionDays }), /Invalid/);
  assert.throws(() => dispatcherConfig({ strategy: "../module" }), /Invalid/);
});
