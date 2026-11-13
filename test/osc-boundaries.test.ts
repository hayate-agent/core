import assert from 'node:assert/strict';
import {test} from 'node:test';
import {plainText,renderEntry} from '../src/channels/presentation.js';
const E='\x1b',B='\x07',S=E+'\\';
for(const [name,input,expected] of [
 ['ST hyperlink',`${E}]8;;https://example.invalid${S}label${E}]8;;${S}`,'label'],
 ['two ST titles',`before${E}]0;one${S}middle${E}]0;two${S}after`,'beforemiddleafter'],
 ['BEL titles',`before${E}]0;one${B}middle${E}]0;two${B}after`,'beforemiddleafter'],
 ['mixed terminators',`${E}]0;one${S}middle${E}]0;two${B}`,'middle'],
] as const)test(name,()=>assert.equal(plainText(input),expected));
test('actual renderEntry keeps hyperlink label without terminal controls',()=>{
 const output=renderEntry({kind:'assistant',text:`${E}]8;;https://example.invalid${S}visible label${E}]8;;${S}`},false);
 assert.equal(output,'│ visible label');assert.equal(output.includes(E),false);
});
