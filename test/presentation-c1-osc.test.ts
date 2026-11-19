import test from 'node:test';
import assert from 'node:assert/strict';
import { plainText, renderEntry } from '../src/channels/presentation.js';

test('C1 and mixed OSC controls hide payloads and preserve visible transcript text', () => {
  for (const start of ['\x1b]', '\x9d']) {
    for (const end of ['\x07', '\x1b\\', '\x9c']) {
      const input = `before${start}8;;https://example.invalid${end}visible${start}8;;${end}after`;
      assert.equal(plainText(input), 'beforevisibleafter');
      assert.equal(renderEntry({ kind: 'assistant', text: input }, false), '│ beforevisibleafter');
      assert.equal(plainText(renderEntry({ kind: 'assistant', text: input }, true)), '│ beforevisibleafter');
    }
  }
});

test('OSC boundaries do not consume subsequent ordinary text or control sequences', () => {
  assert.equal(plainText('a\x9d0;one\x9cb\x1b[31mred\x1b[0m\x9d0;two\x07c'), 'abredc');
  assert.equal(plainText('normal\ntext\t☃'), 'normal\ntext\t☃');
  assert.equal(plainText('\x9dunterminated'), 'unterminated', 'existing unterminated behavior is unchanged');
});
