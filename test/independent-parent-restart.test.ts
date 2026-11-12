import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Harness} from '../src/harness.js';
import {ExecutionStore} from '../src/execution.js';
import {FakeRuntime,MemoryChannel} from './fakes.js';

test('independent persisted admission and settled turn survive crash without another parent or child execution',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'independent-restart-'));
 const store=new ExecutionStore(path.join(home,'executions.json'));await store.load();
 const c=await store.submit('mem:room1','child','edit routing','direct',1,{taskId:'parent',depth:0,original:'Fix routing'});
 const claim=await store.claim(c.id);await store.intent(c.id,claim.token!,'edit','unsafe');await store.fail(c.id,claim.token!,'503');
 const h=new Harness({runtime:new FakeRuntime(),executionStore:store,completionCheck:async()=>({state:'continue',next:'Write independent acceptance criteria'})});
 h.restoreSessions([{key:'mem:room1',task:{id:'parent',original:'Fix routing',state:'blocked',depth:0}}]);
 let admissionSnapshot:ReturnType<Harness['snapshotSessions']>=[];
 h.onStateChange=async()=>{if(h.state('mem:room1').task?.recoveryAdmission&&!h.pendingInputs().length) admissionSnapshot=structuredClone(h.snapshotSessions());};
 await h.recoverTasks(); assert.ok(admissionSnapshot[0].task?.recoveryAdmission?.independent);
 await h.stop(0);
 let calls=0;
 const restored=new Harness({runtime:new FakeRuntime(()=>{calls++;return 'independent criteria saved';}),executionStore:store,completionCheck:async()=>({state:'completed'})});
 restored.onStateChange=async()=>{};restored.addChannel(new MemoryChannel());restored.restoreSessions(admissionSnapshot);
 await restored.recoverTasks();assert.equal(restored.pendingInputs().length,1);
 const input=structuredClone(restored.pendingInputs()[0]);input.executionTurnId='settled-parent';
 await store.beginTurn(input.executionTurnId,'mem:room1');
 await store.settleTurn(input.executionTurnId,'mem:room1',{outbox:[],consumed:[],continuation:{state:'completed'}});
 await restored.stop(0);
 const final=new Harness({runtime:new FakeRuntime(()=>{calls++;return 'duplicate';}),executionStore:store});
 final.onStateChange=async()=>{};final.addChannel(new MemoryChannel());final.restoreSessions(admissionSnapshot);final.restorePending([input]);
 try {final.releaseRestored();await final.drained();assert.equal(calls,0);assert.equal(final.state('mem:room1').task?.state,'completed');assert.equal(store.list()[0].status,'blocked');await assert.rejects(store.claim(c.id));}
 finally {await final.stop(0);await rm(home,{recursive:true,force:true});}
});
