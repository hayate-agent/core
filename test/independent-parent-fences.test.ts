import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Harness} from '../src/harness.js';
import {ExecutionStore} from '../src/execution.js';
import {FakeRuntime,MemoryChannel} from './fakes.js';

for(const fence of ['changed-child','cancel','pause','expiry','queue','save'] as const) test(`independent decision cannot cross ${fence}`,async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'parent-fence-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const store=new ExecutionStore(path.join(home,'executions.json'));await store.load();
 const child=await store.submit('mem:room1','child','Edit routing','direct',1,{taskId:'parent',depth:0,original:'Fix routing'});
 const c=await store.claim(child.id);await store.intent(child.id,c.token!,'edit','unsafe');await store.fail(child.id,c.token!,'503');
 let now=1000,calls=0,saves=0;
 const runtime=new FakeRuntime();
 const h=new Harness({runtime,executionStore:store,now:()=>now,completionCheck:async()=>{
  calls++;
  if(fence==='changed-child') await store.control(child.id,'cancel');
  if(fence==='cancel') h.state('mem:room1').task!.state='stopped';
  if(fence==='pause') h.paused=true;
  if(fence==='expiry') now=3000;
  if(fence==='queue') h.restorePending([{source:'channel',sessionKey:'mem:room1',text:'new work'}]);
  return {state:'continue',next:'Write separate acceptance criteria'};
 }});
 h.addChannel(new MemoryChannel());t.after(()=>h.stop(0));
 h.onStateChange=async()=>{if(++saves===2&&fence==='save') throw Error('disk full');};
 h.restoreSessions([{key:'mem:room1',task:{id:'parent',original:'Fix routing',state:'blocked',explicitBlocked:true,depth:0,expiresAt:2000}}]);
 if(fence==='save') await assert.rejects(h.recoverTasks(),/disk full/);else await h.recoverTasks();
 assert.equal(calls,1);assert.equal(runtime.opened.length,0);
 assert.equal(h.state('mem:room1').task!.recoveryAdmission,undefined);
 assert.equal(h.pendingInputs().filter(i=>i.source==='heartbeat').length,0);
});
