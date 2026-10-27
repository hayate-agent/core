import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruningPolicy } from '../src/tool-result-pruning.js';
import { pruneToolResults } from '../src/builtin-plugins/tool-result-projector.js';

test('head and tail excerpts preserve surrogate pairs without mutating source', () => {
 const policy=pruningPolicy({proactivePruneTokens:1,minResultChars:1000,maxResultChars:500,keepRecent:1});
 for(let prefix=0;prefix<6;prefix++) {
  const body='a'.repeat(prefix)+'😀'.repeat(3000);
  const tool=(id:string,text:string)=>({role:'toolResult',toolCallId:id,toolName:'bash',content:[{type:'text',text}]});
  const messages=[tool('old',body),tool('recent','latest')];
  const original=JSON.stringify(messages);
  const result=pruneToolResults(messages,policy);
  assert.equal(result[0].content[0].text.isWellFormed(),true,`prefix ${prefix}`);
  assert.ok(result[0].content[0].text.length<=500);
  assert.equal(result[1],messages[1]);
  assert.equal(JSON.stringify(messages),original);
 }
});
