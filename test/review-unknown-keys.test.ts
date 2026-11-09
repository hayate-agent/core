import test from "node:test";
import assert from "node:assert/strict";
import { reviewConfig } from "../src/review-config.ts";

test("review config rejects misspelled keys instead of silently using defaults", () => {
  for (const input of [{ enabeld: false }, { maxturns: 1 }, { mandatory: { locl: false } }, { scope: { mod: "all" } }, { "x\ny": 1 }])
    assert.throws(() => reviewConfig(input as never), /Unknown review setting/);
});

test("review config keeps accepting known keys, explicit undefined and empty input", () => {
  assert.equal(reviewConfig({ enabled: false }).enabled, false);
  assert.equal(reviewConfig({ maxTurns: 1, thinking: "high", baseRef: "origin/main" }).maxTurns, 1);
  assert.equal(reviewConfig({ mandatory: { local: false } }).mandatory.local, false);
  assert.equal(reviewConfig({ scope: { mode: "all" } }).scope.mode, "all");
  assert.equal(reviewConfig({ model: undefined, baseRef: undefined, shellGuard: true }).shellGuard, true);
  assert.equal(reviewConfig({}).enabled, false);
  assert.equal(reviewConfig().enabled, false);
});
