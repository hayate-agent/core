import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TurnActivity,type ActivitySnapshot} from '../src/activity.js';
test('publication callback cannot mutate future event evidence',()=>{
 const observed:ActivitySnapshot[]=[];
 const activity=new TurnActivity({id:'synthetic',role:'main',context:'operator',outputTags:['alpha']},event=>{
  observed.push(structuredClone(event.snapshot));
  event.snapshot.outputTags!.push('changed');
  if(event.snapshot.tools[0]){event.snapshot.tools[0].name='changed';event.snapshot.tools[0].callId='changed';}
 },{intervalMs:300000});
 try{
  activity.event({type:'tool',phase:'start',callId:'call',name:'read'});
  activity.running();
  // Model selection now publishes its own event; verify every snapshot rather
  // than pinning the count to the older lifecycle.
  assert.ok(observed.length >= 3);
  const originalCallId = observed.find(snapshot => snapshot.tools.length > 0)!.tools[0].callId;
  assert.notEqual(originalCallId,'changed');
  for (const snapshot of observed) {
   assert.deepEqual(snapshot.outputTags,['alpha']);
   for (const tool of snapshot.tools) {
    assert.equal(tool.name,'read');
    assert.equal(tool.callId,originalCallId);
   }
  }
  assert.ok(observed.some(snapshot => snapshot.tools.length > 0));
 }finally{activity.finish('completed');}
});
