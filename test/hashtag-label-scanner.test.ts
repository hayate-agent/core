import test from 'node:test';
import assert from 'node:assert/strict';
import { labelOutput } from '../src/hashtags.js';

const oldLabel = (text: string) => '#host · ' + text.replace(/^(?:#[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*\s+)+·\s*/g, '');

test('host labels handle long model envelopes without recursive regex overflow', () => {
  const labels = '#tag '.repeat(3_000_000);
  assert.equal(labelOutput(labels + '· body', ['host']), '#host · body');
  assert.equal(labelOutput(labels + 'body', ['host']), '#host · ' + labels + 'body');
});

test('label scanner preserves existing short-input envelope semantics', () => {
  let checked = 0;
  for (const a of ['', '#one ', '#A-2\t', '#x\n', '#bad--tag ', ' #one ', '#one\u00a0']) {
    for (const b of ['', '#two ', '#two\n', '#2bad ', 'plain ']) {
      for (const c of ['· body', '·\n\tbody', 'body', '·', '· · body']) {
        const text = a + b + c;
        assert.equal(labelOutput(text, ['host']), oldLabel(text), JSON.stringify(text));
        checked++;
      }
    }
  }
  assert.equal(checked, 175);
  assert.equal(labelOutput('body', []), 'body');
  assert.equal(labelOutput('', ['host']), '');
});
