import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewConfig } from "../src/review-config.js";

test("review.scope must be an object", () => {
  for (const scope of [null, "all", [], 7, true]) {
    assert.throws(() => reviewConfig({ scope: scope as never }), /Invalid review\.scope/, String(JSON.stringify(scope)));
  }
});

test("valid review.scope values remain accepted", () => {
  assert.equal(reviewConfig().scope.mode, "risk");
  assert.equal(reviewConfig({ scope: {} }).scope.mode, "risk");
  assert.equal(reviewConfig({ scope: undefined }).scope.mode, "risk");
  assert.equal(reviewConfig({ scope: { mode: "all" } }).scope.mode, "all");
  assert.deepEqual(Object.keys(reviewConfig({ scope: { mode: "all" } }).scope).sort(), ["mode", "nonBlockingPaths", "requiredPaths"]);
});
