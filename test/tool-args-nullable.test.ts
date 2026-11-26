import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareStructuredToolArgs } from "../src/tool-args.js";

for (const type of [["array", "null"], ["null", "array"], ["object", "null"], ["null", "object"]]) {
  test(`nullable ${type.join("|")} decodes its declared structured shape`, () => {
    const shape = type.find(t => t !== "null");
    const value = shape === "array" ? [1, { ok: true }] : { ok: [1] };
    const schema = { properties: { value: { type } } };
    const args = { value: " \n" + JSON.stringify(value) };
    assert.deepEqual(prepareStructuredToolArgs(schema, args), { value });
    assert.equal(typeof args.value, "string");
  });
  test(`nullable ${type.join("|")} preserves null, wrong shapes and malformed JSON`, () => {
    const schema = { properties: { value: { type } } };
    const wrong = type.includes("array") ? "{}" : "[]";
    for (const value of [null, "null", wrong, "[broken", "{broken", 0, "3"]) {
      const args = { value };
      assert.strictEqual(prepareStructuredToolArgs(schema, args), args);
    }
  });
}
test("ambiguous or invalid unions and primitive strings are untouched", () => {
  for (const type of [["array", "object"], ["array", "string", "null"], ["string", "null"], [], ["null"], ["array", 1], ["array", "array", "null"]]) {
    const schema = { properties: { value: { type } } };
    const args = { value: "[]" };
    assert.strictEqual(prepareStructuredToolArgs(schema, args), args);
  }
});
test("real structured nullable values retain object identity", () => {
  for (const value of [null, [1], { ok: true }]) {
    const args = { value };
    assert.strictEqual(prepareStructuredToolArgs({ properties: { value: { type: [Array.isArray(value) ? "array" : "object", "null"] } } }, args), args);
  }
});
