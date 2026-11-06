// SPDX-License-Identifier: Apache-2.0
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Harness} from '../src/harness.js';
import {FakeRuntime,MemoryChannel,ROOM} from './fakes.js';
test('turn cancellation denies and removes pending approval',async()=>{
const runtime=new FakeRuntime();const h=new Harness({runtime,tickMs:60000,log:()=>{}});h.addChannel(new MemoryChannel());
try{
 const s=h.state('probe');s.replyTo=ROOM;
 // Open fixture once so the next turn can be held without any model call.
 await h.submit({id:'seed',sessionKey:'probe',source:'channel',text:'seed',replyTo:ROOM});await h.drained();
 runtime.sessions.get('probe')!.hold();
 h.enqueue({id:'held',sessionKey:'probe',source:'channel',text:'held',replyTo:ROOM});
 for(let i=0;i<100&&!s.prompting;i++)await new Promise(r=>setTimeout(r,1));
 assert.ok(s.prompting);
 const approval=h.requestApproval('probe','synthetic_tool',{text:'synthetic'});
 await new Promise(r=>setImmediate(r));assert.equal(h.approvals.size,1);
 assert.equal(await h.cancel('probe','held'),'running');await h.drained();
 const pending=h.approvals.size;
 const entry=[...h.approvals.values()][0];entry?.resolve(true);
 const resolution=await approval;
 console.log(JSON.stringify({pendingAfterCancel:pending,lateApprovalResolution:resolution,turnCancelled:!s.running}));
 assert.equal(pending,0,'cancelled turn must not retain approval');
 assert.equal(resolution,false,'cancelled turn approval must be denied');
}finally{await h.stop(0);}

});
