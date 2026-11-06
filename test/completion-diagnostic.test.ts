// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCompletion } from "./completion-default.js";
import type { CompletionDiagnostic } from "../src/completion-check.js";

for (const [raw, expected] of [["uncertain", "inconclusive"], ["{", "invalid_response"], ["null", "invalid_response"], ["technical", "technical"]] as const) {
  test(`production assessment reports bounded ${expected} without changing legacy undefined`, async () => {
    const observed: CompletionDiagnostic[] = [];
    const backend = { review: async () => {
      if (raw === "technical") throw Error("SECRET raw error");
      return raw === "uncertain" ? '{"state":"uncertain"}' : raw;
    } };
    const result = await assessCompletion(backend, { source: "heartbeat", sessionKey: "mem:room1", text: "Check report" },
      "Existing report", { task: "Read-only hourly report" }, new AbortController().signal,
      undefined, undefined, undefined, value => observed.push(value));
    assert.equal(result, undefined);
    assert.deepEqual(observed, [expected]);
  });
}
