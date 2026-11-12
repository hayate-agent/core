import test from 'node:test';
import assert from 'node:assert/strict';
import {Harness} from '../src/harness.js';
import {FakeRuntime,MemoryChannel,msg} from './fakes.js';

for (const diagnostic of [undefined, 'inconclusive'] as const) {
 test(`missing independent admission remains recoverable (${diagnostic})`,async()=>{
  let h:Harness,now=1000,checks=0,effects=0;
  const runtime=new FakeRuntime(()=>{
   if(effects++===0){h.planContinuation('mem:room1',{state:'continue',next:'Verify remaining delivery'});return 'Implementation remains open';}
   return 'Delivery verified';
  });
  h=new Harness({runtime,now:()=>now,tickMs:600000,completionCheck:async(_input,_reply,_signal,report)=>{
   checks++;
   if(checks===1){if(diagnostic)report?.(diagnostic);return undefined;}
   return effects===1?{state:'continue',next:'Verify remaining delivery'}:{state:'completed'};
  }});
  h.addChannel(new MemoryChannel());h.onStateChange=async()=>{};
  try{
   await h.submit(msg('Implement and verify delivery'));await h.drained();
   const task=h.snapshotSessions()[0].tasks![0];
   assert.equal(task.state,'active');assert.equal(task.explicitBlocked,false);
   assert.equal(task.supervisorDecision?.verdict,'unresolved');
   assert.equal(task.recoveryRetry?.attempts,1);assert.equal(effects,1);
   await h.tick();assert.equal(checks,1); // no early or unadmitted work
   now+=60001;await h.tick();await h.drained();
   assert.equal(effects,2);
  }finally{await h.stop(0);}
 });
}

for (const guard of ['none','semantic','terminated','expired','budget','paused','stopped','held'] as const) {
 test(`persisted missing decision recovery preserves ${guard}`,async()=>{
  let now=1000,checks=0;
  const h=new Harness({runtime:new FakeRuntime(),now:()=>now,tickMs:600000,
   completionCheck:async()=>{checks++;return {state:'blocked'};}});
  h.addChannel(new MemoryChannel());h.onStateChange=async()=>{};
  const task:any={id:'old',original:'Deliver the authorized fix',state:'blocked',depth:0,
   next:'Inspect actual effects before delivery',explicitBlocked:true,
   supervisorDecision:{proposal:'continue',verdict:'unresolved'}};
  if(guard==='semantic')task.supervisorDecision.verdict='blocked';
  if(guard==='terminated')task.termination='productive_budget_exhausted';
  if(guard==='expired')task.expiresAt=999;
  if(guard==='budget')task.depth=20;
  if(guard==='held')task.recoveryEnrollment='held-legacy';
  h.restoreSessions([{key:'mem:room1',tasks:[task],...(guard==='stopped'?{stopPending:true}:{})}]);
  if(guard==='paused')h.paused=true;
  try{
   await h.recoverTasks();assert.equal(checks,0);
   const saved=h.snapshotSessions()[0].tasks![0];
   assert.equal(saved.state,guard==='none'?'active':'blocked');
   if(guard==='none'){
    assert.equal(saved.explicitBlocked,false);now+=60001;await h.recoverTasks();
    assert.equal(checks,1);assert.equal(h.snapshotSessions()[0].tasks![0].state,'blocked');
    assert.equal(h.pendingInputs().length,0);
   }
  }finally{await h.stop(0);}
 });
}

test('operator clarification during assessment retains original continuation for reassessment',async()=>{
 let h:Harness,now=1000,entered!:()=>void,release!:()=>void;
 const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 let calls=0;
 const runtime=new FakeRuntime(text=>{
  if(text==='Implement review owner')h.planContinuation('mem:room1',{state:'continue',next:'Inspect review owner implementation'});
  return text==='Implement review owner'?'Implementation remains open':'Existing merge rights remain';
 });
 h=new Harness({runtime,now:()=>now,tickMs:600000,completionCheck:async(input)=>{
  if(input.text==='Implement review owner'&&calls++===0){entered();await gate;return undefined;}
  return {state:'completed'};
 }});h.addChannel(new MemoryChannel());h.onStateChange=async()=>{};
 try{
  await h.submit(msg('Implement review owner'));await started;
  await h.submit({...msg('Keep existing merge rights'),id:'clarification'});release();await h.drained();
  const task=h.snapshotSessions()[0].tasks!.find(t=>t.original==='Implement review owner')!;
  assert.equal(task.state,'active');assert.equal(task.supervisorDecision?.verdict,'unresolved');
  assert.equal(task.next,'Inspect review owner implementation');assert.ok(task.recoveryRetry);
  assert.equal(runtime.sessions.get('mem:room1')!.prompts.length,2);
 }finally{release();await h.stop(0);}
});
