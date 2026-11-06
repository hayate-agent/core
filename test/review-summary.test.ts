// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeReview } from "../src/builtin-plugins/review-summary.js";
import { reviewPrompt, type ReviewState, type ReviewRound } from "../src/builtin-plugins/review.js";
import type { Changeset } from "../src/changeset.js";

test("review projection excludes full history and bounds current findings without mutating ledger", () => {
  const finding = { id: "x", severity: "P2" as const, file: "a.ts", line: 1, title: "optional", evidence: "e".repeat(20000) };
  const state: ReviewState = { version: 1, root: "/repo", base: "base", status: "escalated",
    rounds: [{ fingerprint: "current", assessment: [], findings: Array.from({ length: 100 }, (_, i) => ({ ...finding, id: String(i) })) }],
    history: Array.from({ length: 227 }, () => ({ rounds: [{ fingerprint: "SECRET-HISTORY-MARKER", assessment: [], error: "h".repeat(20000) }] })) };
  const before = JSON.stringify(state);
  const text = summarizeReview(state);
  assert.ok(text.length < 8000);
  assert.equal(text.includes("SECRET-HISTORY-MARKER"), false);
  assert.equal(JSON.parse(text).omittedFindings, 92);
  assert.equal(JSON.parse(text).blockers, 0);
  assert.equal(JSON.stringify(state), before);
});

test("reviewer prompt bounds earlier rounds independently of ledger size", () => {
  const rounds: ReviewRound[] = Array.from({ length: 227 }, (_, i) => ({ fingerprint: `round-${i}`, assessment: [], error: "x".repeat(100000) }));
  const prompt = reviewPrompt({ base: "base", diff: "small diff" } as Changeset, rounds);
  assert.ok(prompt.length < 5000);
  assert.equal(prompt.includes('"round-0"'), false);
  assert.equal(prompt.includes('"round-226"'), true);
  assert.equal(rounds[0].error!.length, 100000);
});
