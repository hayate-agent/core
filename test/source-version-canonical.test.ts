import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceVersion } from '../src/source-version.js';

const head = 'a'.repeat(40), old = 'b'.repeat(40);
const tags = (...versions: string[]) => versions.map(v => `${head} refs/tags/v${v}`).join('\n');
for (const version of ['01.2.3', '1.02.3', '1.2.03']) {
  test(`ignore noncanonical tag ${version}`, () => {
    assert.equal(sourceVersion(head, tags('1.2.2', version), ''), '1.2.2');
  });
  test(`ignore noncanonical package fallback ${version}`, () => {
    assert.equal(sourceVersion(head, '', '', version), `0.0.0+git.${head.slice(0, 12)}`);
  });
}
test('canonical zeros remain valid', () => {
  assert.equal(sourceVersion(head, tags('0.0.0'), ''), '0.0.0');
  assert.equal(sourceVersion(head, '', '', '0.2.0'), `0.2.0+git.${head.slice(0, 12)}`);
});
test('invalid nearer tag does not mask canonical ancestor', () => {
  assert.equal(sourceVersion(head, `${tags('02.0.0')}\n${old} refs/tags/v1.4.0`, old), `1.4.0+dev.${head.slice(0, 12)}`);
});
test('annotated canonical tags remain supported', () => {
  assert.equal(sourceVersion(head, `${old} refs/tags/v2.0.0\n${head} refs/tags/v2.0.0^{}`, ''), '2.0.0');
});
