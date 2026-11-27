import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedTopicInput } from '../src/topic-labels.js';

// Independent reference is the original JSON-serializer based implementation.
function reference(text: string, budget: number): string {
  let result = '', used = 2;
  for (const point of text) {
    used += JSON.stringify(point).length - 2;
    if (used > budget) break;
    result += point;
  }
  return result;
}

test('topic prefixes retain exact JSON escape widths for all UTF-16 code units', () => {
  for (let code = 0; code <= 0xffff; code++) {
    const text = 'a'.repeat(1594) + String.fromCharCode(code).repeat(8);
    assert.equal(boundedTopicInput(text, [], []).incoming, reference(text, 1600), `code ${code}`);
  }
});

test('topic prefixes preserve astral pairs and mixed escaping at every cutoff', () => {
  const text = 'a😀"\\\b\t\n\f\r\u0000\ud800x\udfff漢'.repeat(200);
  for (let budget = 64; budget <= 1700; budget++) {
    const actual = boundedTopicInput(text, [], [], budget).incoming;
    assert.equal(actual, reference(text, Math.min(1600, budget - 64)));
  }
  const data = boundedTopicInput('hello', [{ id: 'one', text, tags: ['one'] }], [{ role: 'user', text }]);
  assert.equal(data.recent[0].text, reference(text, 242));
  assert.equal(data.candidates[0].text, reference(text, 322));
});
