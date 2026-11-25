import test from 'node:test';
import assert from 'node:assert/strict';
import {transcriptEntries} from '../src/hashtags.js';
const valid={id:'u1',type:'message',message:{role:'user',content:'synthetic'}};
const expected={id:'u1',role:'user',text:'synthetic'};
const cases: Array<[string,unknown[],unknown[]]>=[
 ['plain user',[valid],[expected]],
 ['text block',[{id:'u2',type:'message',message:{role:'user',content:[{type:'text',text:'one'},{type:'image',data:'ignored'},{type:'text',text:'two'}]}}],[{id:'u2',role:'user',text:'one\ntwo'}]],
 ['custom',[{id:'c1',type:'custom'}],[{id:'c1',role:'custom',text:''}]],
 ['null isolated',[null,valid],[expected]],
 ['scalar isolated',[42,valid],[expected]],
 ['missing id',[{type:'message',message:{role:'user',content:'bad'}},valid],[expected]],
 ['empty id',[{id:'',type:'message'},valid],[expected]],
 ['missing type',[{id:'bad'},valid],[expected]],
];
for(const [label,input,output] of cases) test(`transcript structural records: ${label}`,()=>{
 assert.deepEqual(transcriptEntries(input),output);
});
