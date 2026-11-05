import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Harness} from '../src/harness.js';
import {ExecutionStore} from '../src/execution.js';
import {FakeRuntime,MemoryChannel} from './fakes.js';

test('existing task receives one independent admission despite unknown legacy children, without replay',async t=>{
 const home=await mkdtemp(path.join(os.tmpdir(),'legacy-existing-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const store=new ExecutionStore(path.join(home,'executions.json'));await store.load();
 for(let i=0;i<3;i++){const e=await store.submit('mem:room1','old-'+i,'Old unrelated ticket work','direct',1);const c=await store.claim(e.id);await store.intent(e.id,c.token!,'unknown-'+i,'unsafe');await store.fail(e.id,c.token!,'Interrupted');}
 const before=JSON.stringify(store.list());let assessed=0;let runs=0;
 const h=new Harness({runtime:new FakeRuntime(()=>{runs++;return 'Independent evidence check complete';}),executionStore:store,now:()=>1000,completionCheck:async(_input,evidence)=>{
  assessed++;if(assessed===1){assert.match(evidence,/dependencyReconciliation/);assert.match(evidence,/unknown-0/);return {state:'continue',next:'Read the independent acceptance checklist without controlling or repeating old workers'};}
  return {state:'completed'};
 }});h.addChannel(new MemoryChannel());h.onStateChange=async()=>{};t.after(()=>h.stop(0));
 h.restoreSessions([{key:'mem:room1',replyTo:{channel:'mem',target:'room1'},task:{id:'existing',original:'Check independent acceptance checklist',state:'blocked',depth:0,explicitBlocked:true}}]);
 await h.recoverTasks();assert.equal(h.pendingInputs().length,1);await h.start();h.releaseRestored();await h.drained();
 assert.equal(runs,1);assert.equal(JSON.stringify(store.list()),before);assert.equal(h.state('mem:room1').task?.state,'completed');
});
