import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Harness} from '../src/harness.js';
import {ExecutionStore} from '../src/execution.js';
import {FakeRuntime, MemoryChannel} from './fakes.js';

for (const proposal of ['blocked','waiting'] as const) test(`semantic continue overrides ${proposal} and runs independent parent steps after real child effect and 503`, async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'independent-parent-'));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const store=new ExecutionStore(path.join(home,'executions.json')); await store.load();
 const child=await store.submit('mem:room1','child','Edit routing','direct',1,{taskId:'parent',depth:0,original:'Fix routing and document acceptance criteria'});
 const claim=await store.claim(child.id);
 await store.intent(child.id,claim.token!,'edit-routing','unsafe');
 await writeFile(path.join(home,'child.txt'),'partial edit');
 await store.fail(child.id,claim.token!,'HTTP 503 no healthy upstream');
 let assessments=0, runs=0;
 let denied=0;
 const runtime=new FakeRuntime();
 const open=runtime.open.bind(runtime);
 runtime.open=async(key,options)=>{
   const session=await open(key,options);
   session.prompt=async()=>{
     await h.guardWaitTool(key,'bash',{command:'write separate acceptance document'});
     for(const tool of ['plugin_dispatch','plugin_worker_tasks','plugin_subagent']) {
       await assert.rejects(h.guardWaitTool(key,tool,{action:'resume',id:child.id}),/cannot replay or control (blocked|retained) workers/); denied++;
     }
     runs++; writeFileSync(path.join(home,`criteria-${runs}.txt`),'Acceptance: preserve routing identity');
     h.planContinuation(key,{state:proposal,next:'Child is blocked'});
     return 'Acceptance criteria documented separately.';
   };
   return session;
 }; 
 const h=new Harness({runtime,executionStore:store,now:()=>1000,completionCheck:async(input,evidence)=>{
   if (++assessments === 3) return {state:'completed'};
   if (assessments === 2) { assert.match(evidence,/independentParentStep/); return {state:'continue',next:'Write a separate acceptance checklist, not routing code'}; }
   assert.match(input.text,/Fix routing/); assert.match(evidence,/edit-routing/);
   return {state:'continue',next:'Write acceptance criteria to a separate document without editing routing or restarting the worker'};
 }});
 h.addChannel(new MemoryChannel());
 let saved: ReturnType<Harness['snapshotSessions']> = [];
 h.onStateChange=async()=>{ saved=structuredClone(h.snapshotSessions()); writeFileSync(path.join(home,'sessions.json'),JSON.stringify(saved)); };
 h.restoreSessions([{key:'mem:room1',task:{id:'parent',original:'Fix routing and document acceptance criteria',state:'blocked',depth:0,explicitBlocked:true},replyTo:{channel:'mem',target:'room1'}}]);
 t.after(()=>h.stop(0));
 await h.recoverTasks();
 assert.equal(h.pendingInputs().length,1,'independent supervisor decision must enqueue its admitted next step');
 await h.start(); h.releaseRestored();
 for(let i=0;i<100&&h.state('mem:room1').task?.state!=='completed';i++) await new Promise(r=>setTimeout(r,10));
 assert.equal(h.state('mem:room1').task?.state,'completed');
 assert.equal(runs,2); assert.equal(denied,6);
 for (const n of [1,2]) assert.equal(await readFile(path.join(home,`criteria-${n}.txt`),'utf8'),'Acceptance: preserve routing identity');
 assert.equal(await readFile(path.join(home,'child.txt'),'utf8'),'partial edit');
 assert.equal(store.list().find(e=>e.id===child.id)?.status,'blocked');
 await assert.rejects(store.claim(child.id)); await assert.rejects(store.control(child.id,'resume'));
 assert.equal(assessments,3);
 await h.stop(1000);
 const restartedRuntime=new FakeRuntime(()=>{throw Error('duplicate execution');});
 const restarted=new Harness({runtime:restartedRuntime,executionStore:store,now:()=>1000,completionCheck:async()=>{throw Error('duplicate assessment');}});
 restarted.onStateChange=async()=>{};
 restarted.restoreSessions(JSON.parse(await readFile(path.join(home,'sessions.json'),'utf8')));
 try { await restarted.recoverTasks(); assert.equal(restarted.pendingInputs().length,0); assert.equal(restartedRuntime.opened.length,0); }
 finally { await restarted.stop(0); }
});


test('answered stalled child exposes bounded retained clarification to the exact parent assessment without replay', async t => {
 const home=await mkdtemp(path.join(os.tmpdir(),'answered-stall-')); t.after(()=>rm(home,{recursive:true,force:true}));
 const store=new ExecutionStore(path.join(home,'executions.json')); await store.load();
 const original='Fix routing and verify delivery';
 const child=await store.submit('mem:room1','child','Inspect routing','sequential',1,{taskId:'parent',depth:0,original});
 const claim=await store.claim(child.id); await store.intent(child.id,claim.token!,'worker-effect','unsafe');
 await store.checkpoint(child.id,claim.token!,JSON.stringify({outcomes:[],assessment:{index:0,reply:'Evidence: receipt 17',mainClarification:true}}));
 await store.ask(child.id,claim.token!,'What remains? Receipt 17 observed',true);
 const question=store.list()[0]!.question!; await store.answer('mem:room1',child.id,question.id,'Check live receipt independently');
 const resumed=await store.claim(child.id,{strategy:'sequential',version:1,replaySafe:false,reconcile:true}); await store.fail(child.id,resumed.token!,'assessment-stalled');
 const before=store.list()[0]!; let assessments=0; let observed='';
 const h=new Harness({runtime:new FakeRuntime(),executionStore:store,now:()=>1000,completionCheck:async(_input,evidence)=>{
   assessments++; observed=evidence; return {state:'blocked'};
 }});
 h.addChannel(new MemoryChannel()); h.onStateChange=async()=>{};
 h.restoreSessions([{key:'mem:room1',task:{id:'parent',original,state:'blocked',depth:0,explicitBlocked:true},replyTo:{channel:'mem',target:'room1'}}]);
 try { await h.recoverTasks(); assert.equal(assessments,1); assert.equal(h.pendingInputs().length,0);
   const data=JSON.parse(observed); const item=data.executions.find((e:{id:string})=>e.id===child.id);
   assert.deepEqual(item.retainedAssessment,{question:'What remains? Receipt 17 observed',answer:'Check live receipt independently'});
   assert.match(data.dependencyReconciliation,/do not retry, resume, cancel, resolve or replay/);
   const after=store.list()[0]!; assert.deepEqual(after.intent,before.intent); assert.equal(after.status,'blocked'); assert.equal(after.recoveryGrant,undefined);
 } finally { await h.stop(0); }
});
