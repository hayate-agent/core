import assert from "node:assert/strict";
import { test } from "node:test";
import { validateModelSetting } from "../src/model-settings.js";

test("model references reject C0, DEL and C1 control characters", () => {
  for (const value of ["p/m\u0000x", "p/m\u001bx", "p/m\u007fx", "p/m\u0085x", "p\u009f/m"]) {
    for (const key of ["model", "reviewModel", "hashtagModel"] as const) {
      assert.throws(() => validateModelSetting(key, value), /provider\/model/, JSON.stringify(value));
    }
  }
  assert.doesNotThrow(() => validateModelSetting("model", "p/model-1.5:latest"));
});
