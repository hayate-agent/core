import test from "node:test";
import assert from "node:assert/strict";
import { approvalPreview } from "../src/approval-preview.js";

test("approval path preview neutralises bidi and line-separator characters", () => {
  for (const c of ["\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f", "\u061c", "\u2028", "\u2029"]) {
    assert.equal(approvalPreview("write", { path: `src/${c}gpj.sh` }), 'path: "src/ gpj.sh"');
  }
  assert.equal(approvalPreview("write", { path: "a b/ü.txt" }), 'path: "a b/ü.txt"');
});
