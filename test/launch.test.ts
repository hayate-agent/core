// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchMode } from "../src/launch.js";

test("bare invocation selects interactive UI; explicit commands keep their modes", () => {
  assert.equal(launchMode([]), "interactive");
  for (const args of [["run"], ["init"], ["doctor"], ["--help"], ["version"]]) {
    assert.equal(launchMode(args), "command");
  }
});
