import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultConfig } from "../src/config.js";
import { dispatcherConfig, pickModelRule } from "../src/dispatcher-config.js";

test("dispatcher stays off without explicit concurrency support", () => {
  assert.equal(dispatcherConfig().enabled, false);
  assert.equal(dispatcherConfig().capacity, 4);
  assert.equal(defaultConfig({ dispatcher: { enabled: true, concurrentRequests: true } }).dispatcher?.capacity, 4);
  assert.equal(dispatcherConfig({ capacity: 1 }).capacity, 1); // explicit backend/operator limit survives
  assert.throws(() => defaultConfig({ dispatcher: { enabled: true } }), /concurrentRequests/);
  const config = defaultConfig({ dispatcher: { enabled: true, concurrentRequests: true, capacity: 7, strategy: "custom" } });
  assert.deepEqual(config.dispatcher, { enabled: true, concurrentRequests: true, capacity: 7, strategy: "custom", retentionDays: 7, countAuxiliaryRuns: false });
});
test("dispatcher rejects invalid capacity and policy", () => {
  for (const capacity of [0, -1, 1.5, Infinity]) assert.throws(() => dispatcherConfig({ capacity }), /Invalid/);
  for (const retentionDays of [0, -1, 1.5, 3651, Infinity]) assert.throws(() => dispatcherConfig({ retentionDays }), /Invalid/);
  assert.throws(() => dispatcherConfig({ strategy: "../module" }), /Invalid/);
});
test("dispatcher rules validate model routing entries", () => {
  const rules = [
    { match: { minChars: 1200 }, model: "p/big", thinking: "medium" },
    { match: {}, model: "p/small", thinking: "off" },
  ];
  assert.deepEqual(dispatcherConfig({ rules }).rules, rules);
  assert.deepEqual(dispatcherConfig({ rules: [] }).rules, []);
  for (const rule of [{ model: "no-slash" }, { model: "" }, { model: 5 }, { model: "p/big", thinking: "yolo" },
      { match: { minChars: -1 }, model: "p/m" }, { match: { minChars: 5, maxChars: 1 }, model: "p/m" },
      { match: { keywords: [""] }, model: "p/m" }, { match: { keywords: "x" }, model: "p/m" },
      { match: { regex: "(" }, model: "p/m" }, { match: { regex: 5 }, model: "p/m" },
      { match: { nonsense: 1 }, model: "p/m" }, { match: "str", model: "p/m" }, {},
      { model: "p/m", extra: 1 }, { model: "p/m", thinking: "medium", extra: 1 }]) {
    assert.throws(() => dispatcherConfig({ rules: [rule] }), /Invalid/, JSON.stringify(rule));
  }
  // Fallback must be the last rule and only once.
  assert.throws(() => dispatcherConfig({ rules: [{ match: {}, model: "p/s" }, { match: { minChars: 1 }, model: "p/b" }] }), /Invalid/);
  assert.throws(() => dispatcherConfig({ rules: [{ match: { minChars: 1 }, model: "p/b" }, { match: {}, model: "p/s" }, { match: { minChars: 2 }, model: "p/c" }] }), /Invalid/);
  assert.throws(() => dispatcherConfig({ rules: [{ match: { minChars: 1 }, model: "p/b" }, { match: {}, model: "p/s" }, { match: {}, model: "p/t" }] }), /Invalid/);
  assert.doesNotThrow(() => dispatcherConfig({ rules: [{ match: { minChars: 1 }, model: "p/b" }, { match: {}, model: "p/s" }] }));
  assert.doesNotThrow(() => dispatcherConfig({ rules: [{ match: {}, model: "p/only" }] }));
});
test("pickModelRule selects the first matching rule deterministically", () => {
  const rules = [
    { match: { keywords: ["deploy", "merge"] }, model: "p/critical" },
    { match: { minChars: 1000, maxChars: 3000 }, model: "p/big" },
    { match: { regex: "\\d+ files" }, model: "p/counted" },
    { match: {}, model: "p/fallback" },
  ];
  assert.equal(pickModelRule("please deploy the service", rules)?.model, "p/critical");
  assert.equal(pickModelRule("x".repeat(1500), rules)?.model, "p/big");
  assert.equal(pickModelRule("touching 3 files in one PR", rules)?.model, "p/counted");
  assert.equal(pickModelRule("small task", rules)?.model, "p/fallback");
  const noFallback = rules.slice(0, 3);
  assert.equal(pickModelRule("small task", noFallback), undefined);
  assert.equal(pickModelRule("anything", []), undefined);
  assert.equal(pickModelRule("anything", undefined), undefined);
});
