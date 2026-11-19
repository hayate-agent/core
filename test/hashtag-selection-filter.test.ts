import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectHashtagContext } from '../src/hashtags.js';

test('selection skips key construction for unrelated tags and keeps snapshot copies', () => {
  const selected = { tag: 'wanted', sessionId: 's', messageId: 'm', date: 'd' };
  let serializedFields = 0;
  const unrelated = Array.from({ length: 1000 }, () => ({
    tag: 'other',
    get sessionId() { serializedFields++; return 'unrelated'; },
    get messageId() { serializedFields++; return 'id'; },
    date: 'd',
  }));
  const tags = ['wanted'];
  const result = selectHashtagContext('conversation', tags, [selected, ...unrelated])!;
  assert.equal(serializedFields, 0);
  assert.deepEqual(result.references, [selected]);
  result.tags.push('new');
  result.references[0].date = 'changed';
  assert.deepEqual(tags, ['wanted']);
  assert.equal(selected.date, 'd');
});

test('selection retains newest-first multi-tag union, deduplication and cap', () => {
  const index = Array.from({ length: 12 }, (_, i) => ({ tag: 'a', sessionId: 's', messageId: String(i), date: 'd' }));
  index.push({ ...index[11], tag: 'b' });
  const result = selectHashtagContext('c', ['a', 'b'], index)!;
  assert.deepEqual(result.references.map(ref => ref.messageId), ['11', '10', '9', '8', '7', '6', '5', '4']);
  assert.equal(result.references[0].tag, 'b');
  assert.equal(selectHashtagContext('c', [], index), undefined);
  assert.deepEqual(selectHashtagContext('c', ['missing'], index)?.references, []);
});
