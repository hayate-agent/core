import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatcherConfig,pickModelRule} from '../src/dispatcher-config.js';
test('zero upperbound is effective not fallback',()=>{
 const config=dispatcherConfig({rules:[{model:'test/zero',match:{maxChars:0}},{model:'test/fallback'}]});
 assert.equal(pickModelRule('',config.rules)?.model,'test/zero');
 assert.equal(pickModelRule('a',config.rules)?.model,'test/fallback');
});
test('zero lowerbound alone is still fallback',()=>assert.throws(()=>dispatcherConfig({rules:[{model:'test/zero',match:{minChars:0}},{model:'test/fallback'}]}),/Invalid/));
test('empty keywords alone are still fallback',()=>assert.throws(()=>dispatcherConfig({rules:[{model:'test/zero',match:{keywords:[]}},{model:'test/fallback'}]}),/Invalid/));
