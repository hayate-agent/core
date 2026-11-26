import assert from "node:assert/strict";
import test from "node:test";
import { parseInterval, formatInterval } from "../src/interval.js";

for (const ms of [1, 999, 1000, 1500, 60000, 5400000, Number.MAX_SAFE_INTEGER]) {
  test(`millisecond roundtrip: ${ms}`, () => {
    assert.equal(parseInterval(formatInterval(ms)), ms);
  });
}
for (const [input, expected] of [["1s500ms", 1500], [" 1500MS ", 1500], ["1h30m", 5400000]] as const) {
  test(`millisecond parse: ${input}`, () => assert.equal(parseInterval(input), expected));
}
for (const input of ["0ms", "-1ms", "1.5ms", "9007199254740992ms", "9007199254740991ms1ms", "1", "ms", "1mss", "1ms1ms", "1ms1s", "1s1ms1s"]) {
  test(`millisecond invalid: ${input}`, () => assert.equal(parseInterval(input), undefined));
}
