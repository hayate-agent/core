import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHashtags } from '../src/hashtags.js';
for (const [name,text,want] of [
 ['backtick suffix','```\n```js\n#hidden\n```\n#visible',['visible']],
 ['tilde suffix','~~~\n~~~js\n#hidden\n~~~\n#visible',['visible']],
 ['short backtick','````\n```\n#hidden\n````\n#visible',['visible']],
 ['short tilde','~~~~\n~~~\n#hidden\n~~~~\n#visible',['visible']],
 ['long closer','```\n#hidden\n````\n#visible',['visible']],
 ['equal closer','~~~lang\n#hidden\n~~~  \n#visible',['visible']],
] as const) test(name,()=>assert.deepEqual(parseHashtags(text),want));
