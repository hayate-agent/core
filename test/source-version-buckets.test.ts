import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceVersion } from '../src/source-version.js';
const head = 'a'.repeat(40), older = 'b'.repeat(40);
const tags = (n: number, commit = head) => Array.from({length:n}, (_,i) => `${commit} refs/tags/v1.0.${i}`).join('\n');
test('source version groups many release tags without changing numeric selection', () => {
  for (const n of [1, 100, 1000, 5000]) assert.equal(sourceVersion(head,tags(n),'','0.1.0'),`1.0.${n-1}`);
});
test('source version preserves peeled tags, nearest history and fallbacks', () => {
  assert.equal(sourceVersion(head,`${tags(3,older)}\n${head} refs/tags/v2.0.0\n${older} refs/tags/v2.0.0^{}`,older),'2.0.0+dev.'+head.slice(0,12));
  assert.equal(sourceVersion(head,`${tags(5,older)}\n${head} refs/tags/overlay-v99.0.0`,older),'1.0.4+dev.'+head.slice(0,12));
  assert.equal(sourceVersion(head,'','','0.2.0'),'0.2.0+git.'+head.slice(0,12));
  assert.equal(sourceVersion(head,'','','bad'),'0.0.0+git.'+head.slice(0,12));
  assert.throws(()=>sourceVersion('bad','',''));
});
