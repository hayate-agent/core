// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderEntry, plainText, type MessageKind } from "../src/channels/presentation.js";

test("conversation roles and outcomes are distinct with and without color", () => {
  const kinds: MessageKind[] = ["user", "assistant", "info", "success", "error", "cancelled"];
  const plain = kinds.map((kind) => renderEntry({ kind, text: "Hello\nsecond line" }, false));
  assert.equal(new Set(plain.map((s) => s.split("\n")[0])).size, kinds.length);
  for (const kind of kinds) {
    const entry = { kind, text: "Hello\nsecond line" };
    assert.equal(plainText(renderEntry(entry, true)), renderEntry(entry, false));
    assert.ok(!renderEntry(entry, false).includes("\x1b"));
  }
  assert.match(plain[0]!, /^❯ Hello\n  second line$/);
  assert.match(plain[1]!, /^│ Hello\n│ second line$/);
  assert.ok(!plain.join("\n").includes("Du"));
  assert.ok(!plain.join("\n").includes("Assistent"));
  assert.ok(!plain.join("\n").includes("agent:"));
});

test("external content cannot inject terminal colors, clear commands or OSC titles", () => {
  const text = "before\x1b[2J\x1b[31mred\x1b[0m\x1b]0;injected\x07after";
  assert.equal(plainText(text), "beforeredafter");
  assert.ok(!renderEntry({ kind: "assistant", text }, false).includes("\x1b"));
});
