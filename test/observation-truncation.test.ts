import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectObservation} from '../src/completion-budget.js';
import {resolveCompletionContext} from '../src/completion-context.js';

test('reprojecting a bounded tool envelope retains incompleteness',()=>{
 const original=JSON.stringify({type:'toolResult',toolCallId:'call',toolName:'read',text:'synthetic '.repeat(2000)});
 const first=projectObservation(original,'toolResult',500);
 assert.equal(first.truncated,true);
 const second=projectObservation(first.text,'toolResult',8000);
 assert.equal(second.text,first.text);assert.equal(second.truncated,true);
 const context=resolveCompletionContext(undefined,[],[],[{id:'e',role:'toolResult',text:first.text}]);
 assert.equal(context.incomplete,true);assert.equal(context.observations[0].truncated,true);
 for(const text of ['plain',JSON.stringify({truncated:true}),'{broken']) assert.equal(projectObservation(text,'toolResult',8000).truncated,false);
});
